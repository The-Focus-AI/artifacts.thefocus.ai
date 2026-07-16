import { randomBytes, randomUUID } from "node:crypto";

import MarkdownIt from "markdown-it";

import {
  authenticatePublisherToken,
  type PublisherTokenStore,
} from "./auth.js";
import { formatUnifiedDiff } from "./diff.js";
import { rewriteDocAssetMarkdown } from "./doc-asset-rewrite.js";
import { deriveMarkdownTitle, markdownBody } from "./front-matter.js";
import { createOpaqueId, defaultPublicBaseUrl } from "./publication.js";
import {
  contentTypeForDocAssetPath,
  type DocAssetContentStore,
} from "./storage/doc-asset-content.js";
import {
  type CommentOrigin,
  type LivingDoc,
  type LivingDocComment,
  type LivingDocMetadataStore,
  type LivingDocSuggestion,
  type SuggestionStatus,
} from "./storage/living-doc-metadata.js";

export {
  collectDocAssets,
  extractRelativeImageRefs,
  readCollectedDocAsset,
  toHostedAssetPath,
  type CollectedDocAsset,
  type CollectDocAssetsResult,
} from "./doc-asset-collect.js";
export { rewriteDocAssetMarkdown } from "./doc-asset-rewrite.js";
export {
  deriveMarkdownTitle,
  formatFrontMatterFieldValue,
  joinFrontMatter,
  markdownBody,
  parseFrontMatterData,
  parseFrontMatterFieldValue,
  serializeFrontMatterData,
  splitFrontMatter,
  titleFromFrontMatter,
} from "./front-matter.js";
export {
  contentTypeForDocAssetPath,
  createVercelBlobDocAssetContentStore,
  docAssetBlobPath,
  InMemoryDocAssetContentStore,
  normalizeDocAssetPath,
  VercelBlobDocAssetContentStore,
  type DocAssetContentStore,
} from "./storage/doc-asset-content.js";
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

export interface PublishDocAssetPayload {
  relativeRef: string;
  assetPath: string;
  contentType?: string;
  /** Raw file bytes (Buffer) or base64 string from the API. */
  data: Buffer | string;
}

export interface PublishLivingDocInput {
  markdown: string;
  publisherEmail: string;
  publicBaseUrl: string;
  store: LivingDocMetadataStore;
  title?: string | null;
  opaqueId?: string;
  reviewId?: string;
  contentStore?: DocAssetContentStore;
  assets?: PublishDocAssetPayload[];
}

export interface PublishLivingDocResult {
  opaqueId: string;
  reviewId: string;
  title: string | null;
  viewUrl: string;
  reviewUrl: string;
  uploadedAssets: string[];
}

export async function publishLivingDoc(
  input: PublishLivingDocInput,
): Promise<PublishLivingDocResult> {
  assertMarkdownWithinLimit(input.markdown);
  const opaqueId = input.opaqueId ?? createOpaqueId();
  const reviewId = input.reviewId ?? createReviewId();
  const assets = input.assets ?? [];

  let markdown = input.markdown;
  const uploadedAssets: string[] = [];
  const uploadedLocators: string[] = [];

  if (assets.length > 0) {
    if (!input.contentStore) {
      throw new Error(
        "Doc Asset content store is required when uploading assets.",
      );
    }
    const refToHostedUrl = new Map<string, string>();
    const uploadedPaths = new Set<string>();

    try {
      for (const asset of assets) {
        const body =
          typeof asset.data === "string"
            ? Buffer.from(asset.data, "base64")
            : asset.data;
        if (!uploadedPaths.has(asset.assetPath)) {
          const written = await input.contentStore.write({
            opaqueId,
            assetPath: asset.assetPath,
            body,
            contentType:
              asset.contentType ?? contentTypeForDocAssetPath(asset.assetPath),
          });
          uploadedLocators.push(written.locator);
          uploadedPaths.add(asset.assetPath);
          uploadedAssets.push(asset.assetPath);
        }
        refToHostedUrl.set(
          asset.relativeRef,
          livingDocAssetUrl(input.publicBaseUrl, opaqueId, asset.assetPath),
        );
      }
      markdown = rewriteDocAssetMarkdown(input.markdown, refToHostedUrl);
      assertMarkdownWithinLimit(markdown);
    } catch (error) {
      if (uploadedLocators.length > 0) {
        await input.contentStore
          .delete(uploadedLocators)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  const doc = await input.store.create({
    opaqueId,
    reviewId,
    publisherEmail: input.publisherEmail,
    currentMarkdown: markdown,
    title: input.title ?? deriveMarkdownTitle(markdown),
  });
  return {
    opaqueId: doc.opaqueId,
    reviewId: doc.reviewId,
    title: doc.title,
    viewUrl: livingDocViewUrl(input.publicBaseUrl, doc.opaqueId),
    reviewUrl: livingDocReviewUrl(input.publicBaseUrl, doc.reviewId),
    uploadedAssets,
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
  anchorStart: number | null;
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
  // Character offset of the anchored span in the pulled Markdown. Optional,
  // but the only way to disambiguate when anchorQuote appears more than once.
  anchorStart?: number | null;
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
    const anchorStart = suggestion.anchorStart ?? null;
    if (
      anchorStart !== null &&
      (!Number.isInteger(anchorStart) || anchorStart < 0)
    ) {
      throw new Error(
        "Suggestion anchorStart must be a non-negative integer offset.",
      );
    }
    createdSuggestions.push(
      await input.store.addSuggestion({
        id: randomUUID(),
        livingDocId: doc.opaqueId,
        versionNumber,
        anchorQuote: suggestion.anchorQuote,
        anchorStart,
        anchorEnd:
          anchorStart === null
            ? null
            : anchorStart + suggestion.anchorQuote.length,
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
  const updated = await store.updateMarkdown(doc.opaqueId, markdown, {
    title: deriveMarkdownTitle(markdown),
  });
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
  // How many places the anchored quote matched in the live Markdown at
  // decision time, so the UI can flag ambiguous applies.
  occurrenceCount: number;
}

/**
 * Accept or reject an agent Suggestion. Accepting applies the change to the
 * live Markdown at the anchored quote — when the quote matches more than one
 * place, the occurrence nearest the Suggestion's anchorStart offset wins. If
 * the quote no longer exists (the Reviewer edited past it), the Suggestion
 * stays pending so its replacement text remains visible on the review surface
 * instead of vanishing with an accepted-but-unapplied status.
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
  const occurrences = findOccurrences(markdown, suggestion.anchorQuote);
  let applied = false;
  if (decision === "accepted") {
    const index = pickOccurrence(occurrences, suggestion.anchorStart);
    if (index !== null) {
      markdown =
        markdown.slice(0, index) +
        suggestion.replacement +
        markdown.slice(index + suggestion.anchorQuote.length);
      await store.updateMarkdown(doc.opaqueId, markdown, {
        title: deriveMarkdownTitle(markdown),
      });
      applied = true;
    } else {
      return {
        suggestion,
        markdown,
        applied: false,
        occurrenceCount: occurrences.length,
      };
    }
  }

  const updated = await store.setSuggestionStatus(suggestionId, decision);
  if (!updated) throw new Error("Suggestion could not be updated.");
  return {
    suggestion: updated,
    markdown,
    applied,
    occurrenceCount: occurrences.length,
  };
}

function findOccurrences(haystack: string, needle: string): number[] {
  const occurrences: number[] = [];
  if (!needle) return occurrences;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    occurrences.push(index);
    index = haystack.indexOf(needle, index + 1);
  }
  return occurrences;
}

function pickOccurrence(
  occurrences: number[],
  anchorStart: number | null,
): number | null {
  if (occurrences.length === 0) return null;
  if (anchorStart === null) return occurrences[0];
  let best = occurrences[0];
  for (const occurrence of occurrences) {
    if (Math.abs(occurrence - anchorStart) < Math.abs(best - anchorStart)) {
      best = occurrence;
    }
  }
  return best;
}

// --- Request handlers --------------------------------------------------------

export interface ServeLivingDocViewInput {
  request: Request;
  store: LivingDocMetadataStore;
  contentStore?: DocAssetContentStore;
}

export async function serveLivingDocViewRequest({
  request,
  store,
  contentStore,
}: ServeLivingDocViewInput): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse("Method not allowed", 405);
  }
  const route = livingDocViewRouteFromUrl(request.url);
  if (!route) return textResponse("Not found", 404);
  const doc = await store.getByOpaqueId(route.opaqueId);
  if (!doc || doc.status !== "active") return textResponse("Not found", 404);

  if (route.assetPath) {
    if (!contentStore) return textResponse("Not found", 404);
    const content = await contentStore.read(route.opaqueId, route.assetPath);
    if (!content) return textResponse("Not found", 404);
    return new Response(
      request.method === "HEAD" ? null : new Uint8Array(content.body),
      {
        status: 200,
        headers: livingDocSafetyHeaders({
          "content-type": content.contentType ?? "application/octet-stream",
        }),
      },
    );
  }

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
  contentStore?: DocAssetContentStore;
}

export async function handleLivingDocAgentApiRequest({
  request,
  store,
  tokenStore,
  publicBaseUrl = defaultPublicBaseUrl,
  contentStore,
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
        assets?: Array<{
          relativeRef?: string;
          assetPath?: string;
          contentType?: string;
          data?: string;
        }>;
      };
      if (typeof body.markdown !== "string") {
        return jsonResponse({ error: "markdown is required" }, 400);
      }
      const assets: PublishDocAssetPayload[] = [];
      for (const asset of body.assets ?? []) {
        if (
          typeof asset.relativeRef !== "string" ||
          typeof asset.assetPath !== "string" ||
          typeof asset.data !== "string"
        ) {
          return jsonResponse(
            {
              error:
                "each asset requires relativeRef, assetPath, and base64 data",
            },
            400,
          );
        }
        assets.push({
          relativeRef: asset.relativeRef,
          assetPath: asset.assetPath,
          contentType: asset.contentType,
          data: asset.data,
        });
      }
      return jsonResponse(
        await publishLivingDoc({
          markdown: body.markdown,
          title: body.title ?? undefined,
          publisherEmail,
          publicBaseUrl,
          store,
          contentStore,
          assets,
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

export function livingDocAssetUrl(
  publicBaseUrl: string,
  opaqueId: string,
  assetPath: string,
): string {
  const normalized = assetPath.replace(/^\/+/, "");
  return absoluteLivingDocUrl(
    publicBaseUrl,
    `${livingDocViewPrefix}/${opaqueId}/${normalized}`,
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

export function livingDocViewRouteFromUrl(
  url: string,
): { opaqueId: string; assetPath: string } | null {
  const { pathname } = new URL(url);
  const match = pathname.match(/^\/d\/([^/]+)(?:\/(.*))?$/);
  if (!match?.[1]) return null;
  return {
    opaqueId: match[1],
    assetPath: decodeURIComponent(match[2] ?? ""),
  };
}

export function opaqueIdFromViewUrl(url: string): string | null {
  return livingDocViewRouteFromUrl(url)?.opaqueId ?? null;
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
    anchorStart: suggestion.anchorStart,
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

// html:false keeps raw HTML in reviewer-editable Markdown from reaching the page.
const viewPageMarkdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

function renderViewPage(doc: LivingDoc): string {
  const title = escapeHtml(doc.title ?? "Living Doc");
  // Render the body only so YAML fences are not turned into <hr>; the stored
  // Living Doc Markdown always keeps front matter intact.
  const content = viewPageMarkdownRenderer.render(
    markdownBody(doc.currentMarkdown || ""),
  );
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
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid rgba(127,127,127,0.35); padding: 0.4rem 0.55rem; vertical-align: top; }
  th { text-align: left; background: rgba(127,127,127,0.12); }
  .doc-meta { color: #888; font-size: 0.85rem; margin-bottom: 2rem; }
</style>
</head>
<body>
<main>
  <div class="doc-meta">Living Doc · read-only view</div>
  <article id="content">${content}</article>
</main>
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
