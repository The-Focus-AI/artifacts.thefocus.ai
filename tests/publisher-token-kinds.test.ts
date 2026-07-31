import { describe, expect, it, vi } from "vitest";

import { handleArtifactsApiRequest } from "../api/artifacts.js";
import {
  authenticatePublisherToken,
  createPublisherToken,
  InMemoryPublisherTokenStore,
  issuePublisherToken,
  listPublisherTokens,
  revokePublisherToken,
} from "../src/index.js";
import { runCli } from "../src/cli.js";

function streamCapture() {
  let text = "";
  return {
    stream: {
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

describe("Publisher Token kinds", () => {
  it("prefixes mcp tokens distinctly from cli tokens", () => {
    expect(createPublisherToken("cli")).toMatch(/^tfai_pub_/);
    expect(createPublisherToken("mcp")).toMatch(/^tfai_mcp_/);
    expect(createPublisherToken()).toMatch(/^tfai_pub_/);
  });

  it("records kind and label, and exposes a Token Id that is not the token", async () => {
    const store = new InMemoryPublisherTokenStore();
    const issued = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store,
      kind: "mcp",
      label: "claude desktop",
    });

    expect(issued.kind).toBe("mcp");
    expect(issued.tokenId).toHaveLength(12);
    expect(issued.token).not.toContain(issued.tokenId);

    const [record] = await listPublisherTokens({
      publisherEmail: "publisher@thefocus.ai",
      store,
    });
    expect(record).toMatchObject({
      kind: "mcp",
      label: "claude desktop",
      revokedAt: null,
    });
  });

  it("defaults existing callers to cli tokens", async () => {
    const store = new InMemoryPublisherTokenStore();
    const issued = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store,
    });
    expect(issued.kind).toBe("cli");
  });
});

describe("Publisher Token revocation", () => {
  it("stops a revoked token authenticating without touching the others", async () => {
    const store = new InMemoryPublisherTokenStore();
    const keep = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store,
      kind: "cli",
    });
    const kill = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store,
      kind: "mcp",
    });

    await expect(
      revokePublisherToken({
        tokenId: kill.tokenId,
        publisherEmail: "publisher@thefocus.ai",
        store,
      }),
    ).resolves.toEqual({ tokenId: kill.tokenId, status: "revoked" });

    await expect(
      authenticatePublisherToken({ token: kill.token, store }),
    ).rejects.toThrow("revoked");
    await expect(
      authenticatePublisherToken({ token: keep.token, store }),
    ).resolves.toBe("publisher@thefocus.ai");
  });

  it("reports already-revoked and unknown Token Ids without throwing", async () => {
    const store = new InMemoryPublisherTokenStore();
    const issued = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store,
    });
    const revoke = () =>
      revokePublisherToken({
        tokenId: issued.tokenId,
        publisherEmail: "publisher@thefocus.ai",
        store,
      });

    await revoke();
    await expect(revoke()).resolves.toMatchObject({
      status: "already-revoked",
    });
    await expect(
      revokePublisherToken({
        tokenId: "000000000000",
        publisherEmail: "publisher@thefocus.ai",
        store,
      }),
    ).resolves.toMatchObject({ status: "not-found" });
  });

  it("refuses to revoke another Publisher's token", async () => {
    const store = new InMemoryPublisherTokenStore();
    const theirs = await issuePublisherToken({
      email: "other@thefocus.ai",
      store,
    });

    await expect(
      revokePublisherToken({
        tokenId: theirs.tokenId,
        publisherEmail: "publisher@thefocus.ai",
        store,
      }),
    ).resolves.toMatchObject({ status: "not-found" });
    await expect(
      authenticatePublisherToken({ token: theirs.token, store }),
    ).resolves.toBe("other@thefocus.ai");
  });
});

describe("Publisher Token last-used writes", () => {
  it("writes once, then not again until the interval has passed", async () => {
    const store = new InMemoryPublisherTokenStore();
    const issued = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store,
    });
    const markUsed = vi.spyOn(store, "markUsed");

    const first = new Date("2026-07-31T12:00:00.000Z");
    await authenticatePublisherToken({
      token: issued.token,
      store,
      now: () => first,
    });
    expect(markUsed).toHaveBeenCalledTimes(1);

    // A burst of MCP traffic in the same hour must not write per request.
    for (const offsetMs of [1_000, 60_000, 59 * 60_000]) {
      await authenticatePublisherToken({
        token: issued.token,
        store,
        now: () => new Date(first.getTime() + offsetMs),
      });
    }
    expect(markUsed).toHaveBeenCalledTimes(1);

    await authenticatePublisherToken({
      token: issued.token,
      store,
      now: () => new Date(first.getTime() + 60 * 60_000),
    });
    expect(markUsed).toHaveBeenCalledTimes(2);
  });
});

describe("token administration over the hosted API", () => {
  async function apiWithToken() {
    const store = new InMemoryPublisherTokenStore();
    const issued = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store,
    });
    return { store, token: issued.token, tokenId: issued.tokenId };
  }

  it("requires a Publisher Token to list tokens", async () => {
    const response = await handleArtifactsApiRequest(
      new Request("https://artifacts.thefocus.ai/api/artifacts?action=tokens"),
    );
    expect(response.status).toBe(401);
  });

  it("creates, lists, and revokes through the CLI against a local store", async () => {
    const { store, token } = await apiWithToken();
    const env = { THEFOCUS_ARTIFACTS_TOKEN: token };

    const created = streamCapture();
    await expect(
      runCli(["token", "create", "--for", "mcp", "--label", "desktop"], {
        env,
        stdout: created.stream,
        tokenStore: store,
      }),
    ).resolves.toBe(0);
    expect(created.text()).toContain("tfai_mcp_");
    const newTokenId = created.text().match(/Token Id: ([0-9a-f]{12})/)?.[1];
    expect(newTokenId).toBeDefined();

    const listed = streamCapture();
    await runCli(["token", "list"], {
      env,
      stdout: listed.stream,
      tokenStore: store,
    });
    expect(listed.text()).toContain(newTokenId!);
    expect(listed.text()).toContain("desktop");
    expect(listed.text()).toContain("active");

    const revoked = streamCapture();
    await expect(
      runCli(["token", "revoke", newTokenId!, "--yes"], {
        env,
        stdout: revoked.stream,
        tokenStore: store,
      }),
    ).resolves.toBe(0);
    expect(revoked.text()).toContain("revoked");
  });
});
