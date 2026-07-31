import { z } from "zod";

import { listPublisherTokens, type PublisherTokenRecord } from "../auth.js";
import {
  extractRelativeImageRefs,
  opaqueIdFromViewReference,
  publishLivingDoc,
  pullLivingDocFeedback,
  removeLivingDoc,
  respondToLivingDoc,
  type PublishDocAssetPayload,
} from "../living-doc.js";
import {
  absolutePublicationUrl,
  prepareInlineArtifactUpload,
  publishUploadedArtifact,
  removePublication,
  type InlineArtifactFile,
} from "../publication.js";
import type { McpToolSpec } from "./spec.js";

const inlineFileSchema = z.object({
  artifactPath: z
    .string()
    .describe(
      "Path inside the Artifact, relative and forward-slashed, e.g. 'assets/app.css'.",
    ),
  text: z
    .string()
    .optional()
    .describe("File contents as text. Use for HTML, CSS, JS, SVG, JSON."),
  contentBase64: z
    .string()
    .optional()
    .describe("File contents base64-encoded. Use for images and other binary."),
  contentType: z
    .string()
    .optional()
    .describe("Overrides the content type inferred from the extension."),
});

const suggestionSchema = z.object({
  anchorQuote: z
    .string()
    .describe("Exact text from the pulled Markdown that this replaces."),
  replacement: z.string().describe("The proposed replacement text."),
  note: z
    .string()
    .optional()
    .describe("Why the change is proposed. Shown to the Reviewer."),
  anchorStart: z
    .number()
    .optional()
    .describe(
      "Character offset of anchorQuote in the pulled Markdown. Include it whenever the quote could appear more than once — it decides which occurrence an accepted Suggestion replaces.",
    ),
});

const replySchema = z.object({
  parentCommentId: z
    .string()
    .describe("id of the Comment being replied to, from pull_doc."),
  body: z.string().describe("The reply text."),
});

const publishSizeNote =
  "Content travels inline over HTTPS, so this is for pages and small bundles; publish large directories with the `artifacts` CLI.";

const updateNote =
  "The Revision Window does not apply over MCP — there is no Local Source to match. Publishing always creates a new Publication; to change one in place, call update_artifact with its Publication URL.";

function inlineFilesFromArgs(args: Record<string, unknown>): {
  html?: string;
  files?: InlineArtifactFile[];
  entryPage?: string;
} {
  return {
    html: args.html as string | undefined,
    files: args.files as InlineArtifactFile[] | undefined,
    entryPage: args.entryPage as string | undefined,
  };
}

function docAssetsFromArgs(
  args: Record<string, unknown>,
): PublishDocAssetPayload[] {
  const assets = (args.assets ?? []) as Array<{
    relativeRef: string;
    assetPath: string;
    contentBase64: string;
    contentType?: string;
  }>;
  return assets.map((asset) => ({
    relativeRef: asset.relativeRef,
    assetPath: asset.assetPath,
    contentType: asset.contentType,
    data: asset.contentBase64,
  }));
}

function describeToken(record: PublisherTokenRecord) {
  return {
    tokenId: record.tokenId,
    kind: record.kind,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

export const artifactsMcpTools: McpToolSpec[] = [
  {
    name: "publish_artifact",
    title: "Publish an Artifact",
    kind: "mutation",
    description: [
      "Publish HTML as a new Artifact and return its unlisted Publication URL.",
      "Pass `html` for a single page, or `files` for a multi-file bundle with a root index.html.",
      publishSizeNote,
      updateNote,
    ].join(" "),
    inputSchema: {
      html: z
        .string()
        .optional()
        .describe("A complete HTML document, published as the Entry Page."),
      files: z
        .array(inlineFileSchema)
        .optional()
        .describe("Files of a directory Artifact. Requires an Entry Page."),
      entryPage: z
        .string()
        .optional()
        .describe("Entry Page path within `files`. Defaults to index.html."),
      title: z
        .string()
        .optional()
        .describe(
          "Human-readable Title. Falls back to the page's <title> element.",
        ),
    },
    async run(args, context) {
      const upload = prepareInlineArtifactUpload({
        ...inlineFilesFromArgs(args),
        sourceLabel: "mcp:inline",
      });
      const result = await publishUploadedArtifact({
        upload,
        publisherEmail: context.publisherEmail,
        publicBaseUrl: context.publicBaseUrl,
        metadataStore: context.publicationMetadataStore,
        contentStore: context.artifactContentStore,
        stateStore: context.publicationStateStore,
        title: args.title as string | undefined,
      });
      return {
        publicationUrl: result.publicationUrl,
        opaqueId: result.opaqueId,
        artifactPaths: result.artifactPaths,
      };
    },
  },
  {
    name: "update_artifact",
    title: "Update a published Artifact",
    kind: "mutation",
    description: [
      "Replace the contents of an existing Publication, keeping its URL.",
      "The hosted Artifact mirrors what you send: files you omit are removed.",
      publishSizeNote,
    ].join(" "),
    inputSchema: {
      publicationUrl: z
        .string()
        .describe("The Publication URL to update, from publish_artifact."),
      html: z
        .string()
        .optional()
        .describe("A complete HTML document, published as the Entry Page."),
      files: z
        .array(inlineFileSchema)
        .optional()
        .describe("Files of a directory Artifact. Requires an Entry Page."),
      entryPage: z
        .string()
        .optional()
        .describe("Entry Page path within `files`. Defaults to index.html."),
      title: z.string().optional().describe("Replacement Title."),
    },
    async run(args, context) {
      const upload = prepareInlineArtifactUpload({
        ...inlineFilesFromArgs(args),
        sourceLabel: "mcp:inline",
      });
      const result = await publishUploadedArtifact({
        upload,
        publisherEmail: context.publisherEmail,
        publicBaseUrl: context.publicBaseUrl,
        metadataStore: context.publicationMetadataStore,
        contentStore: context.artifactContentStore,
        stateStore: context.publicationStateStore,
        updatePublicationUrl: args.publicationUrl as string,
        title: args.title as string | undefined,
      });
      return {
        publicationUrl: result.publicationUrl,
        opaqueId: result.opaqueId,
        decision: result.decision,
        artifactPaths: result.artifactPaths,
      };
    },
  },
  {
    name: "remove_artifact",
    title: "Remove a Publication",
    kind: "mutation",
    destructive: true,
    description:
      "Remove a Publication: its URL starts returning 404 and the Artifact contents are deleted. This cannot be undone.",
    inputSchema: {
      publicationUrl: z.string().describe("The Publication URL to remove."),
    },
    async run(args, context) {
      return removePublication({
        publicationUrl: args.publicationUrl as string,
        publisherToken: context.publisherToken,
        metadataStore: context.publicationMetadataStore,
        contentStore: context.artifactContentStore,
        tokenStore: context.tokenStore,
        stateStore: context.publicationStateStore,
      });
    },
  },
  {
    name: "list_artifacts",
    title: "List Publications",
    kind: "discovery",
    description:
      "List this Publisher's Publications with their Titles, URLs, and status.",
    inputSchema: {},
    async run(_args, context) {
      const publications =
        await context.publicationMetadataStore.listByPublisherEmail(
          context.publisherEmail,
        );
      return publications.map((publication) => ({
        opaqueId: publication.opaqueId,
        title: publication.title,
        status: publication.status,
        updatedAt: publication.updatedAt,
        publicationUrl: absolutePublicationUrl(
          context.publicBaseUrl,
          publication.publicationUrlPath,
        ),
      }));
    },
  },
  {
    name: "publish_doc",
    title: "Publish a Living Doc",
    kind: "mutation",
    description: [
      "Publish Markdown as a Living Doc and return a read-only View Link plus a capability Review Link.",
      "Hand the Review Link to whoever should give feedback — no login required.",
      "YAML front matter is preserved. Relative image references need matching `assets` entries, since this surface cannot read your filesystem.",
    ].join(" "),
    inputSchema: {
      markdown: z
        .string()
        .describe("The Markdown body, front matter included."),
      title: z
        .string()
        .optional()
        .describe("Title. Falls back to a `title:` field in front matter."),
      assets: z
        .array(
          z.object({
            relativeRef: z
              .string()
              .describe("The reference as written in the Markdown."),
            assetPath: z
              .string()
              .describe("Path to store it under, e.g. 'images/chart.png'."),
            contentBase64: z.string().describe("File contents, base64."),
            contentType: z.string().optional(),
          }),
        )
        .optional()
        .describe("Doc Assets for images referenced from the Markdown."),
    },
    async run(args, context) {
      const markdown = args.markdown as string;
      const assets = docAssetsFromArgs(args);
      const referenced = extractRelativeImageRefs(markdown);
      const supplied = new Set(assets.map((asset) => asset.relativeRef));
      const missing = referenced.filter((ref) => !supplied.has(ref));
      const result = await publishLivingDoc({
        markdown,
        title: args.title as string | undefined,
        publisherEmail: context.publisherEmail,
        publicBaseUrl: context.publicBaseUrl,
        store: context.livingDocStore,
        contentStore: context.docAssetContentStore,
        assets,
      });
      return missing.length > 0
        ? { ...result, missingAssets: missing }
        : result;
    },
  },
  {
    name: "pull_doc",
    title: "Pull Living Doc feedback",
    kind: "mutation",
    description: [
      "Cut a new Version of a Living Doc and return its current Markdown, a diff versus the previous Version, and open Reviewer Comments.",
      "This advances the Version number, so both sides can refer back to 'as of Version 3'.",
    ].join(" "),
    inputSchema: {
      doc: z.string().describe("A Living Doc View URL or its id."),
    },
    async run(args, context) {
      return pullLivingDocFeedback({
        opaqueId: opaqueIdFromViewReference(args.doc as string),
        publisherEmail: context.publisherEmail,
        store: context.livingDocStore,
      });
    },
  },
  {
    name: "respond_doc",
    title: "Respond to a Living Doc",
    kind: "mutation",
    description: [
      "Post span-anchored Suggestions and replies to Comments on a Living Doc.",
      "Suggestions are never applied automatically — the Reviewer accepts or rejects each one in the editor.",
      "Quote text exactly as it appears in the Markdown returned by pull_doc.",
    ].join(" "),
    inputSchema: {
      doc: z.string().describe("A Living Doc View URL or its id."),
      suggestions: z.array(suggestionSchema).optional(),
      replies: z.array(replySchema).optional(),
    },
    async run(args, context) {
      return respondToLivingDoc({
        opaqueId: opaqueIdFromViewReference(args.doc as string),
        publisherEmail: context.publisherEmail,
        store: context.livingDocStore,
        suggestions: args.suggestions as never,
        replies: args.replies as never,
      });
    },
  },
  {
    name: "remove_doc",
    title: "Remove a Living Doc",
    kind: "mutation",
    destructive: true,
    description:
      "Remove a Living Doc: both its View Link and its Review Link stop serving. Use this to kill a leaked Review Link.",
    inputSchema: {
      doc: z.string().describe("A Living Doc View URL or its id."),
    },
    async run(args, context) {
      return removeLivingDoc({
        opaqueId: opaqueIdFromViewReference(args.doc as string),
        publisherEmail: context.publisherEmail,
        store: context.livingDocStore,
      });
    },
  },
  {
    name: "list_docs",
    title: "List Living Docs",
    kind: "discovery",
    description:
      "List this Publisher's Living Docs with their Titles, Versions, and links.",
    inputSchema: {},
    async run(_args, context) {
      return context.livingDocStore.listByPublisherEmail(
        context.publisherEmail,
      );
    },
  },
  {
    name: "whoami",
    title: "Show the authenticated Publisher",
    kind: "discovery",
    description:
      "Return the Publisher this connection is authenticated as, and the Publisher Tokens on the account.",
    inputSchema: {},
    async run(_args, context) {
      const tokens = await listPublisherTokens({
        publisherEmail: context.publisherEmail,
        store: context.tokenStore,
      });
      return {
        publisherEmail: context.publisherEmail,
        tokens: tokens.map(describeToken),
      };
    },
  },
];

export const artifactsMcpToolsByName = new Map(
  artifactsMcpTools.map((spec) => [spec.name, spec]),
);
