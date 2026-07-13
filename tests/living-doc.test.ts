import { describe, expect, it } from "vitest";

import {
  addReviewerComment,
  decideSuggestion,
  getReviewState,
  InMemoryLivingDocMetadataStore,
  publishLivingDoc,
  pullLivingDocFeedback,
  resolveReviewerComment,
  respondToLivingDoc,
  saveReviewMarkdown,
} from "../src/index.js";

const publisherEmail = "publisher@thefocus.ai";
const publicBaseUrl = "https://artifacts.thefocus.ai";

async function publish(
  store: InMemoryLivingDocMetadataStore,
  markdown: string,
) {
  return publishLivingDoc({
    markdown,
    publisherEmail,
    publicBaseUrl,
    store,
    opaqueId: "docOpaque1",
    reviewId: "reviewSecret1",
  });
}

describe("Living Doc round-trip", () => {
  it("publishes with a view URL, a review URL, and a derived title", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    const result = await publish(store, "# Proposal\n\nFirst draft.");

    expect(result.viewUrl).toBe("https://artifacts.thefocus.ai/d/docOpaque1");
    expect(result.reviewUrl).toBe(
      "https://artifacts.thefocus.ai/r/reviewSecret1",
    );
    expect(result.title).toBe("Proposal");
  });

  it("lets a Reviewer edit and comment, then the agent pulls a Version with a diff", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    await publish(store, "# Proposal\n\nFirst draft.");

    await saveReviewMarkdown(
      store,
      "reviewSecret1",
      "# Proposal\n\nFirst draft, sharpened.",
    );
    await addReviewerComment(store, "reviewSecret1", {
      anchorQuote: "sharpened",
      body: "Can you expand this section?",
      author: "Client",
    });

    const pulled = await pullLivingDocFeedback({
      opaqueId: "docOpaque1",
      publisherEmail,
      store,
    });

    expect(pulled.versionNumber).toBe(1);
    expect(pulled.previousVersionNumber).toBeNull();
    expect(pulled.markdown).toContain("sharpened");
    expect(pulled.openComments).toHaveLength(1);
    expect(pulled.openComments[0]).toMatchObject({
      author: "Client",
      body: "Can you expand this section?",
    });
  });

  it("computes a diff between the two most recent pulled Versions", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    await publish(store, "line one\nline two\n");

    await pullLivingDocFeedback({
      opaqueId: "docOpaque1",
      publisherEmail,
      store,
    });
    await saveReviewMarkdown(store, "reviewSecret1", "line one\nline three\n");
    const second = await pullLivingDocFeedback({
      opaqueId: "docOpaque1",
      publisherEmail,
      store,
    });

    expect(second.versionNumber).toBe(2);
    expect(second.previousVersionNumber).toBe(1);
    expect(second.diffFromPreviousVersion).toContain("-line two");
    expect(second.diffFromPreviousVersion).toContain("+line three");
  });

  it("accepts an agent Suggestion by applying it to the live Markdown", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    await publish(store, "The quick brown fox.");
    await pullLivingDocFeedback({
      opaqueId: "docOpaque1",
      publisherEmail,
      store,
    });

    await respondToLivingDoc({
      opaqueId: "docOpaque1",
      publisherEmail,
      store,
      suggestions: [
        { anchorQuote: "quick brown fox", replacement: "swift auburn fox" },
      ],
    });

    const before = await getReviewState(store, "reviewSecret1");
    expect(before.pendingSuggestions).toHaveLength(1);

    const decision = await decideSuggestion(
      store,
      "reviewSecret1",
      before.pendingSuggestions[0].id,
      "accepted",
    );
    expect(decision.applied).toBe(true);
    expect(decision.markdown).toBe("The swift auburn fox.");

    const after = await getReviewState(store, "reviewSecret1");
    expect(after.markdown).toBe("The swift auburn fox.");
    expect(after.pendingSuggestions).toHaveLength(0);
  });

  it("marks an accepted Suggestion as not applied when its anchor no longer exists", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    await publish(store, "original sentence");
    await pullLivingDocFeedback({
      opaqueId: "docOpaque1",
      publisherEmail,
      store,
    });
    await respondToLivingDoc({
      opaqueId: "docOpaque1",
      publisherEmail,
      store,
      suggestions: [{ anchorQuote: "gone text", replacement: "new text" }],
    });
    const state = await getReviewState(store, "reviewSecret1");

    const decision = await decideSuggestion(
      store,
      "reviewSecret1",
      state.pendingSuggestions[0].id,
      "accepted",
    );
    expect(decision.applied).toBe(false);
    expect(decision.markdown).toBe("original sentence");
  });

  it("lets the agent reply to a Comment and the Reviewer resolve it", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    await publish(store, "draft body");
    const comment = await addReviewerComment(store, "reviewSecret1", {
      anchorQuote: "draft",
      body: "why draft?",
    });
    await pullLivingDocFeedback({
      opaqueId: "docOpaque1",
      publisherEmail,
      store,
    });

    const responded = await respondToLivingDoc({
      opaqueId: "docOpaque1",
      publisherEmail,
      store,
      replies: [{ parentCommentId: comment.id, body: "Renamed to final." }],
    });
    expect(responded.createdReplies).toHaveLength(1);

    await resolveReviewerComment(store, "reviewSecret1", comment.id);
    const open = await store.listComments("docOpaque1", { status: "open" });
    expect(open.filter((c) => c.origin === "reviewer")).toHaveLength(0);
  });

  it("refuses to pull a Living Doc owned by another Publisher", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    await publish(store, "secret");
    await expect(
      pullLivingDocFeedback({
        opaqueId: "docOpaque1",
        publisherEmail: "intruder@thefocus.ai",
        store,
      }),
    ).rejects.toThrow(/another Publisher/);
  });
});
