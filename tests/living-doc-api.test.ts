import { describe, expect, it } from "vitest";

import {
  handleLivingDocAgentApiRequest,
  handleReviewApiRequest,
  InMemoryLivingDocMetadataStore,
  InMemoryPublisherTokenStore,
  issuePublisherToken,
  serveLivingDocViewRequest,
} from "../src/index.js";

async function setup() {
  const store = new InMemoryLivingDocMetadataStore();
  const tokenStore = new InMemoryPublisherTokenStore();
  const { token } = await issuePublisherToken({
    email: "publisher@thefocus.ai",
    store: tokenStore,
  });
  const agent = (request: Request) =>
    handleLivingDocAgentApiRequest({
      request,
      store,
      tokenStore,
      publicBaseUrl: "https://artifacts.thefocus.ai",
    });
  return { store, token, agent };
}

function post(url: string, token: string | null, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("Living Doc agent API", () => {
  it("rejects publish without a Publisher Token", async () => {
    const { agent } = await setup();
    const response = await agent(
      post("https://x/api/doc?action=publish", null, { markdown: "# Hi" }),
    );
    expect(response.status).toBe(401);
  });

  it("runs publish -> pull -> respond over the API", async () => {
    const { agent, store, token } = await setup();

    const published = (await (
      await agent(
        post("https://x/api/doc?action=publish", token, {
          markdown: "# Draft\n\nbody",
          title: "Draft",
        }),
      )
    ).json()) as { opaqueId: string; reviewId: string; viewUrl: string };
    expect(published.viewUrl).toContain("/d/");

    // Reviewer edits through the review API.
    const reviewApi = (request: Request) =>
      handleReviewApiRequest({ request, store });
    await reviewApi(
      post(
        `https://x/api/review?review=${published.reviewId}&action=save`,
        null,
        { markdown: "# Draft\n\nbody, revised" },
      ),
    );

    const pulled = (await (
      await agent(
        post("https://x/api/doc?action=pull", token, {
          opaqueId: published.opaqueId,
        }),
      )
    ).json()) as { versionNumber: number; markdown: string };
    expect(pulled.versionNumber).toBe(1);
    expect(pulled.markdown).toContain("revised");

    const responded = await agent(
      post("https://x/api/doc?action=respond", token, {
        opaqueId: published.opaqueId,
        suggestions: [{ anchorQuote: "revised", replacement: "finalized" }],
      }),
    );
    expect(responded.status).toBe(200);

    const state = (await (
      await reviewApi(
        new Request(
          `https://x/api/review?review=${published.reviewId}&action=state`,
        ),
      )
    ).json()) as { pendingSuggestions: unknown[] };
    expect(state.pendingSuggestions).toHaveLength(1);
  });

  it("serves the read-only view as HTML and as JSON", async () => {
    const { agent, store, token } = await setup();
    const published = (await (
      await agent(
        post("https://x/api/doc?action=publish", token, {
          markdown: "# Visible\n\ntext",
        }),
      )
    ).json()) as { opaqueId: string };

    const html = await serveLivingDocViewRequest({
      request: new Request(`https://x/d/${published.opaqueId}`),
      store,
    });
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("x-robots-tag")).toContain("noindex");
    expect(await html.text()).toContain("# Visible");

    const json = (await (
      await serveLivingDocViewRequest({
        request: new Request(`https://x/d/${published.opaqueId}?format=json`),
        store,
      })
    ).json()) as { markdown: string };
    expect(json.markdown).toContain("Visible");
  });

  it("removes a Living Doc over the API and the view goes 404", async () => {
    const { agent, store, token } = await setup();
    const published = (await (
      await agent(
        post("https://x/api/doc?action=publish", token, {
          markdown: "# Temp",
        }),
      )
    ).json()) as { opaqueId: string };

    const removed = (await (
      await agent(
        post("https://x/api/doc?action=remove", token, {
          opaqueId: published.opaqueId,
        }),
      )
    ).json()) as { status: string };
    expect(removed.status).toBe("removed");

    const view = await serveLivingDocViewRequest({
      request: new Request(`https://x/d/${published.opaqueId}`),
      store,
    });
    expect(view.status).toBe(404);
  });

  it("returns 404 for an unknown Living Doc view", async () => {
    const { store } = await setup();
    const response = await serveLivingDocViewRequest({
      request: new Request("https://x/d/nope"),
      store,
    });
    expect(response.status).toBe(404);
  });
});
