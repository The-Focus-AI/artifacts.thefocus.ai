import { randomBytes, randomUUID } from "node:crypto";

import {
  authenticatePublisherToken,
  type PublisherTokenStore,
} from "./auth.js";
import { formatUnifiedDiff } from "./diff.js";
import { createOpaqueId, defaultPublicBaseUrl } from "./publication.js";
import {
  type CommentOrigin,
  type LivingDoc,
  type LivingDocComment,
  type LivingDocMetadataStore,
  type LivingDocSuggestion,
  type SuggestionStatus,
} from "./storage/living-doc-metadata.js";

export const livingDocViewPrefix = "/d";
export const livingDocReviewPrefix = "/r";

// The review endpoints are reachable by anyone holding a Review Link, so all
// text inputs are size-capped server-side.
export const maxLivingDocMarkdownBytes = 2 * 1024 * 1024;
export const maxLivingDocTextBytes = 64 * 1024;

function assertMarkdownWithinLimit(markdown: string): void {
  if (Buffer.byteLength(markdown, "utf8") > maxLivingDocMarkdownBytes) {
    throw new Error("Living Doc Markdown exceeds the 2 MB limit.");
  }
}

function assertTextWithinLimit(text: string, label: string): void {
  if (Buffer.byteLength(text, "utf8") > maxLivingDocTextBytes) {
    throw new Error(`${label} exceeds the 64 KB limit.`);
  }
}

export interface PublishLivingDocInput {
  markdown: string;
  publisherEmail: string;
  publicBaseUrl: string;
  store: LivingDocMetadataStore;
  title?: string | null;
  opaqueId?: string;
  reviewId?: string;
}

export interface PublishLivingDocResult {
  opaqueId: string;
  reviewId: string;
  title: string | null;
  viewUrl: string;
  reviewUrl: string;
}

export async function publishLivingDoc(
  input: PublishLivingDocInput,
): Promise<PublishLivingDocResult> {
  assertMarkdownWithinLimit(input.markdown);
  const opaqueId = input.opaqueId ?? createOpaqueId();
  const reviewId = input.reviewId ?? createReviewId();
  const doc = await input.store.create({
    opaqueId,
    reviewId,
    publisherEmail: input.publisherEmail,
    currentMarkdown: input.markdown,
    title: input.title ?? deriveMarkdownTitle(input.markdown),
  });
  return {
    opaqueId: doc.opaqueId,
    reviewId: doc.reviewId,
    title: doc.title,
    viewUrl: livingDocViewUrl(input.publicBaseUrl, doc.opaqueId),
    reviewUrl: livingDocReviewUrl(input.publicBaseUrl, doc.reviewId),
  };
}

export interface PullLivingDocInput {
  opaqueId: string;
  publisherEmail: string;
  store: LivingDocMetadataStore;
}

export interface PulledComment {
  id: string;
  origin: CommentOrigin;
  author: string | null;
  anchorQuote: string;
  body: string;
  createdAt: string;
}

export interface PulledSuggestion {
  id: string;
  anchorQuote: string;
  replacement: string;
  note: string | null;
  status: SuggestionStatus;
}

export interface PullLivingDocResult {
  opaqueId: string;
  title: string | null;
  versionNumber: number;
  previousVersionNumber: number | null;
  markdown: string;
  diffFromPreviousVersion: string | null;
  openComments: PulledComment[];
  priorSuggestions: PulledSuggestion[];
}

/**
 * Cut an immutable Version of the Living Doc and return the current Markdown,
 * a diff versus the previous Version, and the open Reviewer feedback. This is
 * the turn boundary: each pull advances the version number.
 */
export async function pullLivingDocFeedback(
  input: PullLivingDocInput,
): Promise<PullLivingDocResult> {
  const doc = await requireOwnedDoc(
    input.store,
    input.opaqueId,
    input.publisherEmail,
  );
  const previousVersion =
    doc.latestVersionNumber > 0
      ? await input.store.getVersion(doc.opaqueId, doc.latestVersionNumber)
      : null;

  const versionNumber = doc.latestVersionNumber + 1;
  await input.store.addVersion({
    id: randomUUID(),
    livingDocId: doc.opaqueId,
    versionNumber,
    markdown: doc.currentMarkdown,
  });
  await input.store.setLatestVersionNumber(doc.opaqueId, versionNumber);

  const openComments = await input.store.listComments(doc.opaqueId, {
    status: "open",
  });
  const suggestions = await input.store.listSuggestions(doc.opaqueId);

  return {
    opaqueId: doc.opaqueId,
    title: doc.title,
    versionNumber,
    previousVersionNumber: previousVersion?.versionNumber ?? null,
    markdown: doc.currentMarkdown,
    diffFromPreviousVersion: previousVersion
      ? formatUnifiedDiff(previousVersion.markdown, doc.currentMarkdown)
      : null,
    openComments: openComments
      .filter((comment) => comment.origin === "reviewer")
      .map(toPulledComment),
    priorSuggestions: suggestions.map(toPulledSuggestion),
  };
}

export interface RespondSuggestionInput {
  anchorQuote: string;
  replacement: string;
  note?: string | null;
}

export interface RespondReplyInput {
  parentCommentId: string;
  body: string;
}

export interface RespondLivingDocInput {
  opaqueId: string;
  publisherEmail: string;
  store: LivingDocMetadataStore;
  suggestions?: RespondSuggestionInput[];
  replies?: RespondReplyInput[];
}

export interface RespondLivingDocResult {
  opaqueId: string;
  versionNumber: number;
  createdSuggestions: PulledSuggestion[];
  createdReplies: PulledComment[];
}

/**
 * The agent's half of the round: post span-anchored Suggestions (never applied
 * automatically) and replies to open Comments. Suggestions target the latest
 * pulled Version.
 */
export async function respondToLivingDoc(
  input: RespondLivingDocInput,
): Promise<RespondLivingDocResult> {
  const doc = await requireOwnedDoc(
    input.store,
    input.opaqueId,
    input.publisherEmail,
  );
  const versionNumber = doc.latestVersionNumber;

  const createdSuggestions: LivingDocSuggestion[] = [];
  for (const suggestion of input.suggestions ?? []) {
    if (!suggestion.anchorQuote) {
      throw new Error("Each Suggestion requires an anchorQuote.");
    }
    assertTextWithinLimit(suggestion.anchorQuote, "Suggestion anchor");
    assertTextWithinLimit(suggestion.replacement, "Suggestion replacement");
    if (suggestion.note)
      assertTextWithinLimit(suggestion.note, "Suggestion note");
    createdSuggestions.push(
      await input.store.addSuggestion({
        id: randomUUID(),
        livingDocId: doc.opaqueId,
        versionNumber,
        anchorQuote: suggestion.anchorQuote,
        replacement: suggestion.replacement,
        note: suggestion.note ?? null,
      }),
    );
  }

  const createdReplies: LivingDocComment[] = [];
  for (const reply of input.replies ?? []) {
    const parent = (await input.store.listComments(doc.opaqueId)).find(
      (comment) => comment.id === reply.parentCommentId,
    );
    if (!parent) {
      throw new Error(`Unknown parent Comment: ${reply.parentCommentId}`);
    }
    assertTextWithinLimit(reply.body, "Reply body");
    createdReplies.push(
      await input.store.addComment({
        id: randomUUID(),
        livingDocId: doc.opaqueId,
        origin: "agent",
        body: reply.body,
        anchorQuote: parent.anchorQuote,
        anchorStart: parent.anchorStart,
        anchorEnd: parent.anchorEnd,
        parentCommentId: parent.id,
      }),
    );
  }

  return {
    opaqueId: doc.opaqueId,
    versionNumber,
    createdSuggestions: createdSuggestions.map(toPulledSuggestion),
    createdReplies: createdReplies.map(toPulledComment),
  };
}

export interface RemoveLivingDocInput {
  opaqueId: string;
  publisherEmail: string;
  store: LivingDocMetadataStore;
}

export interface RemoveLivingDocResult {
  opaqueId: string;
  status: "removed" | "not-found";
}

/**
 * Removal disables the Living Doc: the View Link and Review Link both stop
 * serving it. This is the kill switch for a leaked Review Link.
 */
export async function removeLivingDoc(
  input: RemoveLivingDocInput,
): Promise<RemoveLivingDocResult> {
  const doc = await input.store.getByOpaqueId(input.opaqueId);
  if (!doc || doc.status !== "active") {
    return { opaqueId: input.opaqueId, status: "not-found" };
  }
  if (doc.publisherEmail !== input.publisherEmail) {
    throw new Error("This Living Doc belongs to another Publisher.");
  }
  await input.store.markRemoved(input.opaqueId);
  return { opaqueId: input.opaqueId, status: "removed" };
}

// --- Reviewer-side operations (authorized by holding the Review Link) --------

export interface ReviewStateResult {
  opaqueId: string;
  title: string | null;
  versionNumber: number;
  markdown: string;
  comments: LivingDocComment[];
  pendingSuggestions: LivingDocSuggestion[];
}

export async function getReviewState(
  store: LivingDocMetadataStore,
  reviewId: string,
): Promise<ReviewStateResult> {
  const doc = await requireActiveDocByReviewId(store, reviewId);
  return {
    opaqueId: doc.opaqueId,
    title: doc.title,
    versionNumber: doc.latestVersionNumber,
    markdown: doc.currentMarkdown,
    comments: await store.listComments(doc.opaqueId),
    pendingSuggestions: await store.listSuggestions(doc.opaqueId, {
      status: "pending",
    }),
  };
}

export async function saveReviewMarkdown(
  store: LivingDocMetadataStore,
  reviewId: string,
  markdown: string,
): Promise<LivingDoc> {
  assertMarkdownWithinLimit(markdown);
  const doc = await requireActiveDocByReviewId(store, reviewId);
  const updated = await store.updateMarkdown(doc.opaqueId, markdown);
  if (!updated) throw new Error("Living Doc could not be updated.");
  return updated;
}

export interface AddReviewerCommentInput {
  anchorQuote: string;
  body: string;
  anchorStart?: number | null;
  anchorEnd?: number | null;
  author?: string | null;
}

export async function addReviewerComment(
  store: LivingDocMetadataStore,
  reviewId: string,
  input: AddReviewerCommentInput,
): Promise<LivingDocComment> {
  const doc = await requireActiveDocByReviewId(store, reviewId);
  if (!input.body) throw new Error("A Comment requires a body.");
  assertTextWithinLimit(input.body, "Comment body");
  assertTextWithinLimit(input.anchorQuote, "Comment anchor");
  return store.addComment({
    id: randomUUID(),
    livingDocId: doc.opaqueId,
    origin: "reviewer",
    body: input.body,
    anchorQuote: input.anchorQuote,
    anchorStart: input.anchorStart ?? null,
    anchorEnd: input.anchorEnd ?? null,
    author: input.author ?? null,
  });
}

export async function resolveReviewerComment(
  store: LivingDocMetadataStore,
  reviewId: string,
  commentId: string,
): Promise<LivingDocComment> {
  const doc = await requireActiveDocByReviewId(store, reviewId);
  const comments = await store.listComments(doc.opaqueId);
  if (!comments.some((comment) => comment.id === commentId)) {
    throw new Error("Unknown Comment.");
  }
  const updated = await store.setCommentStatus(commentId, "resolved");
  if (!updated) throw new Error("Comment could not be resolved.");
  return updated;
}

export interface DecideSuggestionResult {
  suggestion: LivingDocSuggestion;
  markdown: string;
  applied: boolean;
}

/**
 * Accept or reject an agent Suggestion. Accepting applies the change to the
 * live Markdown by replacing the first occurrence of the anchored quote; if the
 * quote no longer exists (the Reviewer edited past it), the Suggestion is still
 * marked accepted but reported as not applied so the UI can flag it.
 */
export async function decideSuggestion(
  store: LivingDocMetadataStore,
  reviewId: string,
  suggestionId: string,
  decision: Extract<SuggestionStatus, "accepted" | "rejected">,
): Promise<DecideSuggestionResult> {
  const doc = await requireActiveDocByReviewId(store, reviewId);
  const suggestion = (await store.listSuggestions(doc.opaqueId)).find(
    (candidate) => candidate.id === suggestionId,
  );
  if (!suggestion) throw new Error("Unknown Suggestion.");
  if (suggestion.status !== "pending") {
    throw new Error("Suggestion has already been decided.");
  }

  let markdown = doc.currentMarkdown;
  let applied = false;
  if (decision === "accepted") {
    const index = markdown.indexOf(suggestion.anchorQuote);
    if (index >= 0) {
      markdown =
        markdown.slice(0, index) +
        suggestion.replacement +
        markdown.slice(index + suggestion.anchorQuote.length);
      await store.updateMarkdown(doc.opaqueId, markdown);
      applied = true;
    }
  }

  const updated = await store.setSuggestionStatus(suggestionId, decision);
  if (!updated) throw new Error("Suggestion could not be updated.");
  return { suggestion: updated, markdown, applied };
}

// --- Request handlers --------------------------------------------------------

export interface ServeLivingDocViewInput {
  request: Request;
  store: LivingDocMetadataStore;
}

export async function serveLivingDocViewRequest({
  request,
  store,
}: ServeLivingDocViewInput): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse("Method not allowed", 405);
  }
  const opaqueId = opaqueIdFromViewUrl(request.url);
  if (!opaqueId) return textResponse("Not found", 404);
  const doc = await store.getByOpaqueId(opaqueId);
  if (!doc || doc.status !== "active") return textResponse("Not found", 404);

  const wantsJson =
    new URL(request.url).searchParams.get("format") === "json" ||
    (request.headers.get("accept") ?? "").includes("application/json");
  if (wantsJson) {
    return jsonResponse({
      opaqueId: doc.opaqueId,
      title: doc.title,
      versionNumber: doc.latestVersionNumber,
      markdown: doc.currentMarkdown,
    });
  }

  return new Response(request.method === "HEAD" ? null : renderViewPage(doc), {
    status: 200,
    headers: livingDocSafetyHeaders({
      "content-type": "text/html; charset=utf-8",
    }),
  });
}

export interface HandleAgentApiInput {
  request: Request;
  store: LivingDocMetadataStore;
  tokenStore: PublisherTokenStore;
  publicBaseUrl?: string;
}

export async function handleLivingDocAgentApiRequest({
  request,
  store,
  tokenStore,
  publicBaseUrl = defaultPublicBaseUrl,
}: HandleAgentApiInput): Promise<Response> {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const token = bearerToken(request);
    if (!token)
      return jsonResponse(
        { error: "A valid Publisher Token is required" },
        401,
      );
    const publisherEmail = await authenticatePublisherToken({
      token,
      store: tokenStore,
    });

    if (request.method === "POST" && action === "publish") {
      const body = (await request.json()) as {
        markdown?: string;
        title?: string | null;
      };
      if (typeof body.markdown !== "string") {
        return jsonResponse({ error: "markdown is required" }, 400);
      }
      return jsonResponse(
        await publishLivingDoc({
          markdown: body.markdown,
          title: body.title ?? undefined,
          publisherEmail,
          publicBaseUrl,
          store,
        }),
      );
    }

    if (request.method === "POST" && action === "pull") {
      const body = (await request.json()) as { opaqueId?: string };
      if (!body.opaqueId)
        return jsonResponse({ error: "opaqueId is required" }, 400);
      return jsonResponse(
        await pullLivingDocFeedback({
          opaqueId: body.opaqueId,
          publisherEmail,
          store,
        }),
      );
    }

    if (request.method === "POST" && action === "respond") {
      const body = (await request.json()) as {
        opaqueId?: string;
        suggestions?: RespondSuggestionInput[];
        replies?: RespondReplyInput[];
      };
      if (!body.opaqueId)
        return jsonResponse({ error: "opaqueId is required" }, 400);
      return jsonResponse(
        await respondToLivingDoc({
          opaqueId: body.opaqueId,
          publisherEmail,
          store,
          suggestions: body.suggestions,
          replies: body.replies,
        }),
      );
    }

    if (request.method === "POST" && action === "remove") {
      const body = (await request.json()) as { opaqueId?: string };
      if (!body.opaqueId)
        return jsonResponse({ error: "opaqueId is required" }, 400);
      return jsonResponse(
        await removeLivingDoc({
          opaqueId: body.opaqueId,
          publisherEmail,
          store,
        }),
      );
    }

    if (request.method === "GET" && action === "list") {
      return jsonResponse({
        livingDocs: await store.listByPublisherEmail(publisherEmail),
      });
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
}

export interface HandleReviewApiInput {
  request: Request;
  store: LivingDocMetadataStore;
}

export async function handleReviewApiRequest({
  request,
  store,
}: HandleReviewApiInput): Promise<Response> {
  try {
    const url = new URL(request.url);
    const reviewId = url.searchParams.get("review");
    const action = url.searchParams.get("action") ?? "state";
    if (!reviewId) return jsonResponse({ error: "review is required" }, 400);

    if (request.method === "GET" && action === "state") {
      return jsonResponse(await getReviewState(store, reviewId), 200, {
        "cache-control": "no-store",
      });
    }

    if (request.method === "POST" && action === "save") {
      const body = (await request.json()) as { markdown?: string };
      if (typeof body.markdown !== "string") {
        return jsonResponse({ error: "markdown is required" }, 400);
      }
      const updated = await saveReviewMarkdown(store, reviewId, body.markdown);
      return jsonResponse({
        versionNumber: updated.latestVersionNumber,
        updatedAt: updated.updatedAt,
      });
    }

    if (request.method === "POST" && action === "comment") {
      const body = (await request.json()) as AddReviewerCommentInput;
      return jsonResponse(
        await addReviewerComment(store, reviewId, {
          anchorQuote: body.anchorQuote ?? "",
          body: body.body ?? "",
          anchorStart: body.anchorStart,
          anchorEnd: body.anchorEnd,
          author: body.author,
        }),
      );
    }

    if (request.method === "POST" && action === "resolve-comment") {
      const body = (await request.json()) as { commentId?: string };
      if (!body.commentId)
        return jsonResponse({ error: "commentId is required" }, 400);
      return jsonResponse(
        await resolveReviewerComment(store, reviewId, body.commentId),
      );
    }

    if (request.method === "POST" && action === "decide") {
      const body = (await request.json()) as {
        suggestionId?: string;
        decision?: "accepted" | "rejected";
      };
      if (!body.suggestionId || !body.decision) {
        return jsonResponse(
          { error: "suggestionId and decision are required" },
          400,
        );
      }
      return jsonResponse(
        await decideSuggestion(
          store,
          reviewId,
          body.suggestionId,
          body.decision,
        ),
      );
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
}

// --- URLs & helpers ----------------------------------------------------------

export function livingDocViewUrl(
  publicBaseUrl: string,
  opaqueId: string,
): string {
  return absoluteLivingDocUrl(
    publicBaseUrl,
    `${livingDocViewPrefix}/${opaqueId}`,
  );
}

export function livingDocReviewUrl(
  publicBaseUrl: string,
  reviewId: string,
): string {
  return absoluteLivingDocUrl(
    publicBaseUrl,
    `${livingDocReviewPrefix}/${reviewId}`,
  );
}

export function opaqueIdFromViewUrl(url: string): string | null {
  const { pathname } = new URL(url);
  const match = pathname.match(/^\/d\/([^/]+)\/?$/);
  return match?.[1] ?? null;
}

export function reviewIdFromReviewUrl(url: string): string | null {
  const { pathname } = new URL(url);
  const match = pathname.match(/^\/r\/([^/]+)\/?$/);
  return match?.[1] ?? null;
}

export function opaqueIdFromViewReference(reference: string): string {
  const trimmed = reference.trim();
  if (/^https?:\/\//.test(trimmed)) {
    const opaqueId = opaqueIdFromViewUrl(trimmed);
    if (opaqueId) return opaqueId;
    throw new Error(`Not a Living Doc View URL: ${reference}`);
  }
  return trimmed;
}

export function livingDocSafetyHeaders(headers: HeadersInit = {}): Headers {
  return new Headers({
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    ...headers,
  });
}

export function deriveMarkdownTitle(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) return heading[1].slice(0, 200);
    if (line.trim().length > 0) return line.trim().slice(0, 200);
  }
  return null;
}

function absoluteLivingDocUrl(publicBaseUrl: string, path: string): string {
  const base = publicBaseUrl.endsWith("/")
    ? publicBaseUrl
    : `${publicBaseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

async function requireOwnedDoc(
  store: LivingDocMetadataStore,
  opaqueId: string,
  publisherEmail: string,
): Promise<LivingDoc> {
  const doc = await store.getByOpaqueId(opaqueId);
  if (!doc || doc.status !== "active") throw new Error("Living Doc not found.");
  if (doc.publisherEmail !== publisherEmail) {
    throw new Error("This Living Doc belongs to another Publisher.");
  }
  return doc;
}

async function requireActiveDocByReviewId(
  store: LivingDocMetadataStore,
  reviewId: string,
): Promise<LivingDoc> {
  const doc = await store.getByReviewId(reviewId);
  if (!doc || doc.status !== "active") throw new Error("Living Doc not found.");
  return doc;
}

function toPulledComment(comment: LivingDocComment): PulledComment {
  return {
    id: comment.id,
    origin: comment.origin,
    author: comment.author,
    anchorQuote: comment.anchorQuote,
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
  };
}

function toPulledSuggestion(suggestion: LivingDocSuggestion): PulledSuggestion {
  return {
    id: suggestion.id,
    anchorQuote: suggestion.anchorQuote,
    replacement: suggestion.replacement,
    note: suggestion.note,
    status: suggestion.status,
  };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: livingDocSafetyHeaders(),
  });
}

export function createReviewId(): string {
  return randomBytes(24).toString("base64url");
}

function renderViewPage(doc: LivingDoc): string {
  const payload = JSON.stringify({
    title: doc.title,
    markdown: doc.currentMarkdown,
    versionNumber: doc.latestVersionNumber,
  }).replace(/</g, "\\u003c");
  const title = escapeHtml(doc.title ?? "Living Doc");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
  pre { overflow-x: auto; padding: 1rem; background: rgba(127,127,127,0.12); border-radius: 8px; }
  code { font-family: ui-monospace, monospace; }
  img { max-width: 100%; }
  .doc-meta { color: #888; font-size: 0.85rem; margin-bottom: 2rem; }
</style>
</head>
<body>
<main>
  <div class="doc-meta">Living Doc · read-only view</div>
  <article id="content">Rendering…</article>
</main>
<script type="application/json" id="doc-data">${payload}</script>
<script type="module">
  import MarkdownIt from "https://esm.sh/markdown-it@14";
  const data = JSON.parse(document.getElementById("doc-data").textContent);
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  document.getElementById("content").innerHTML = md.render(data.markdown || "");
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
