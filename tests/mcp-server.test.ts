import { describe, expect, it } from "vitest";

import {
  artifactsMcpTools,
  handleArtifactsMcpRequest,
  InMemoryArtifactContentStore,
  InMemoryDocAssetContentStore,
  InMemoryLivingDocMetadataStore,
  InMemoryPublicationMetadataStore,
  InMemoryPublicationStateStore,
  InMemoryPublisherTokenStore,
  issuePublisherToken,
  revokePublisherToken,
} from "../src/index.js";

const publicBaseUrl = "https://artifacts.thefocus.ai";

async function setup() {
  const tokenStore = new InMemoryPublisherTokenStore();
  const { token } = await issuePublisherToken({
    email: "publisher@thefocus.ai",
    store: tokenStore,
    kind: "mcp",
    label: "test client",
  });
  // Hoisted: the endpoint is stateless, but the stores behind it are not.
  const stores = {
    publicationMetadataStore: new InMemoryPublicationMetadataStore(),
    artifactContentStore: new InMemoryArtifactContentStore(),
    publicationStateStore: new InMemoryPublicationStateStore(),
    livingDocStore: new InMemoryLivingDocMetadataStore(),
    docAssetContentStore: new InMemoryDocAssetContentStore(),
  };
  const call = (request: Request) =>
    handleArtifactsMcpRequest({
      request,
      tokenStore,
      ...stores,
      publicBaseUrl,
    });
  return { tokenStore, token, call, ...stores };
}

/**
 * A stateless MCP endpoint still requires the initialize handshake, so every
 * exchange in these tests opens with one. `mcp-session-id` is absent by design.
 */
function rpc(token: string | null, body: unknown): Request {
  return new Request("https://artifacts.thefocus.ai/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  },
};

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

/** Every tool returns its payload as JSON in a single text content block. */
async function resultJson(response: Response): Promise<unknown> {
  const body = (await response.json()) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
    error?: unknown;
  };
  if (body.error) throw new Error(JSON.stringify(body.error));
  const text = body.result?.content?.[0]?.text ?? "null";
  // Failures carry a plain message rather than JSON, so check before parsing.
  if (body.result?.isError) throw new Error(text);
  return JSON.parse(text) as unknown;
}

async function resultError(response: Response): Promise<string> {
  const body = (await response.json()) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
  };
  expect(body.result?.isError).toBe(true);
  return body.result?.content?.[0]?.text ?? "";
}

/**
 * The endpoint is stateless, so an initialize on one request does not carry to
 * the next. Each exchange re-initializes before doing its work.
 */
async function callTool(
  call: (request: Request) => Promise<Response>,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  await call(rpc(token, initialize));
  return call(rpc(token, toolCall(2, name, args)));
}

describe("MCP tool catalog", () => {
  it("splits every tool into a mutation or a discovery tool", () => {
    for (const spec of artifactsMcpTools) {
      expect(["mutation", "discovery"]).toContain(spec.kind);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("marks discovery tools read-only and never destructive", () => {
    for (const spec of artifactsMcpTools.filter(
      (candidate) => candidate.kind === "discovery",
    )) {
      expect(spec.destructive ?? false).toBe(false);
    }
  });

  it("has unique tool names", () => {
    const names = artifactsMcpTools.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("MCP endpoint authentication", () => {
  it("rejects a request with no Publisher Token", async () => {
    const { call } = await setup();
    const response = await call(rpc(null, initialize));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects an unknown Publisher Token", async () => {
    const { call } = await setup();
    const response = await call(rpc("tfai_mcp_nope", initialize));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
  });

  it("rejects a revoked Publisher Token", async () => {
    const { call, token, tokenStore } = await setup();
    const [record] = await tokenStore.listByPublisherEmail(
      "publisher@thefocus.ai",
    );
    await revokePublisherToken({
      tokenId: record!.tokenId,
      publisherEmail: "publisher@thefocus.ai",
      store: tokenStore,
    });

    const response = await call(rpc(token, initialize));
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("revoked");
  });

  it("accepts a valid Publisher Token and lists the catalog", async () => {
    const { call, token } = await setup();
    await call(rpc(token, initialize));
    const response = await call(
      rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual(
      artifactsMcpTools.map((spec) => spec.name).sort(),
    );
  });

  it("refuses GET and answers DELETE without a session", async () => {
    const { call, token } = await setup();
    const get = await call(
      new Request("https://artifacts.thefocus.ai/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(get.status).toBe(405);

    const del = await call(
      new Request("https://artifacts.thefocus.ai/mcp", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(del.status).toBe(204);
  });
});

describe("MCP Artifact publishing", () => {
  it("publishes a single HTML page and returns a Publication URL", async () => {
    const { call, token } = await setup();
    const result = (await resultJson(
      await callTool(call, token, "publish_artifact", {
        html: "<html><head><title>Report</title></head><body>hi</body></html>",
        title: "Report",
      }),
    )) as { publicationUrl: string; artifactPaths: string[] };

    expect(result.publicationUrl).toMatch(
      /^https:\/\/artifacts\.thefocus\.ai\/a\/[A-Za-z0-9_-]+\/$/,
    );
  });

  it("publishes a multi-file bundle and keeps nested Artifact Paths", async () => {
    const { call, token } = await setup();
    const result = (await resultJson(
      await callTool(call, token, "publish_artifact", {
        files: [
          { artifactPath: "index.html", text: "<html><body>hi</body></html>" },
          { artifactPath: "assets/app.css", text: "body{color:red}" },
        ],
      }),
    )) as { artifactPaths: string[] };

    expect(result.artifactPaths.sort()).toEqual([
      "assets/app.css",
      "index.html",
    ]);
  });

  it("refuses a bundle with no Entry Page", async () => {
    const { call, token } = await setup();
    const message = await resultError(
      await callTool(call, token, "publish_artifact", {
        files: [{ artifactPath: "about.html", text: "<html></html>" }],
      }),
    );
    expect(message).toContain("index.html");
  });

  it("refuses an Artifact Path that escapes the Artifact", async () => {
    const { call, token } = await setup();
    const message = await resultError(
      await callTool(call, token, "publish_artifact", {
        files: [
          { artifactPath: "index.html", text: "<html></html>" },
          { artifactPath: "../escape.txt", text: "nope" },
        ],
      }),
    );
    expect(message).toContain("escape");
  });

  it("refuses html and files together", async () => {
    const { call, token } = await setup();
    const message = await resultError(
      await callTool(call, token, "publish_artifact", {
        html: "<html></html>",
        files: [{ artifactPath: "index.html", text: "<html></html>" }],
      }),
    );
    expect(message).toContain("not both");
  });
});

describe("MCP Living Doc loop", () => {
  it("runs publish_doc, pull_doc, and respond_doc", async () => {
    const { call, token } = await setup();

    const published = (await resultJson(
      await callTool(call, token, "publish_doc", {
        markdown: "# Draft\n\nThe quick brown fox.",
        title: "Draft",
      }),
    )) as { viewUrl: string; reviewUrl: string };
    expect(published.viewUrl).toContain("/d/");
    expect(published.reviewUrl).toContain("/r/");

    const pulled = (await resultJson(
      await callTool(call, token, "pull_doc", { doc: published.viewUrl }),
    )) as { versionNumber: number; markdown: string };
    expect(pulled.versionNumber).toBe(1);
    expect(pulled.markdown).toContain("quick brown fox");

    const responded = (await resultJson(
      await callTool(call, token, "respond_doc", {
        doc: published.viewUrl,
        suggestions: [
          {
            anchorQuote: "quick brown fox",
            replacement: "swift auburn fox",
            note: "tighter",
          },
        ],
      }),
    )) as { createdSuggestions: unknown[] };
    expect(responded.createdSuggestions).toHaveLength(1);
  });

  it("reports Markdown image references with no matching asset", async () => {
    const { call, token } = await setup();
    const result = (await resultJson(
      await callTool(call, token, "publish_doc", {
        markdown: "# Draft\n\n![chart](./images/chart.png)",
      }),
    )) as { missingAssets?: string[] };

    expect(result.missingAssets).toEqual(["./images/chart.png"]);
  });

  it("lists Living Docs through the discovery tool", async () => {
    const { call, token } = await setup();
    await callTool(call, token, "publish_doc", {
      markdown: "# One",
      title: "One",
    });
    const docs = (await resultJson(
      await callTool(call, token, "list_docs", {}),
    )) as Array<{ title: string | null }>;

    expect(docs.map((doc) => doc.title)).toContain("One");
  });
});

describe("MCP identity", () => {
  it("reports the authenticated Publisher and its tokens", async () => {
    const { call, token } = await setup();
    const result = (await resultJson(
      await callTool(call, token, "whoami", {}),
    )) as {
      publisherEmail: string;
      tokens: Array<{ kind: string; label: string | null }>;
    };

    expect(result.publisherEmail).toBe("publisher@thefocus.ai");
    expect(result.tokens[0]).toMatchObject({
      kind: "mcp",
      label: "test client",
    });
  });
});
