import { neon } from "@neondatabase/serverless";

import type { ClockOptions, SqlClient } from "./publication-metadata.js";

export type LivingDocStatus = "active" | "removed";
export type CommentOrigin = "reviewer" | "agent";
export type CommentStatus = "open" | "resolved";
export type SuggestionStatus = "pending" | "accepted" | "rejected";

export interface LivingDoc {
  opaqueId: string;
  reviewId: string;
  publisherEmail: string;
  status: LivingDocStatus;
  title: string | null;
  currentMarkdown: string;
  latestVersionNumber: number;
  createdAt: Date;
  updatedAt: Date;
  removedAt: Date | null;
}

export interface LivingDocVersion {
  id: string;
  livingDocId: string;
  versionNumber: number;
  markdown: string;
  createdAt: Date;
}

export interface LivingDocComment {
  id: string;
  livingDocId: string;
  origin: CommentOrigin;
  author: string | null;
  anchorQuote: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  body: string;
  parentCommentId: string | null;
  status: CommentStatus;
  createdAt: Date;
}

export interface LivingDocSuggestion {
  id: string;
  livingDocId: string;
  versionNumber: number;
  anchorQuote: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  replacement: string;
  note: string | null;
  status: SuggestionStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface CreateLivingDocInput {
  opaqueId: string;
  reviewId: string;
  publisherEmail: string;
  currentMarkdown: string;
  status?: LivingDocStatus;
  title?: string | null;
}

export interface CreateCommentInput {
  id: string;
  livingDocId: string;
  origin: CommentOrigin;
  body: string;
  anchorQuote: string;
  anchorStart?: number | null;
  anchorEnd?: number | null;
  author?: string | null;
  parentCommentId?: string | null;
}

export interface CreateSuggestionInput {
  id: string;
  livingDocId: string;
  versionNumber: number;
  anchorQuote: string;
  replacement: string;
  anchorStart?: number | null;
  anchorEnd?: number | null;
  note?: string | null;
}

export interface CreateVersionInput {
  id: string;
  livingDocId: string;
  versionNumber: number;
  markdown: string;
}

export interface LivingDocMetadataStore {
  create(input: CreateLivingDocInput): Promise<LivingDoc>;
  getByOpaqueId(opaqueId: string): Promise<LivingDoc | null>;
  getByReviewId(reviewId: string): Promise<LivingDoc | null>;
  updateMarkdown(opaqueId: string, markdown: string): Promise<LivingDoc | null>;
  setLatestVersionNumber(
    opaqueId: string,
    versionNumber: number,
  ): Promise<LivingDoc | null>;
  markRemoved(opaqueId: string): Promise<LivingDoc | null>;
  listByPublisherEmail(publisherEmail: string): Promise<LivingDoc[]>;

  addVersion(input: CreateVersionInput): Promise<LivingDocVersion>;
  getVersion(
    opaqueId: string,
    versionNumber: number,
  ): Promise<LivingDocVersion | null>;

  addComment(input: CreateCommentInput): Promise<LivingDocComment>;
  listComments(
    opaqueId: string,
    options?: { status?: CommentStatus },
  ): Promise<LivingDocComment[]>;
  setCommentStatus(
    commentId: string,
    status: CommentStatus,
  ): Promise<LivingDocComment | null>;

  addSuggestion(input: CreateSuggestionInput): Promise<LivingDocSuggestion>;
  listSuggestions(
    opaqueId: string,
    options?: { status?: SuggestionStatus },
  ): Promise<LivingDocSuggestion[]>;
  setSuggestionStatus(
    suggestionId: string,
    status: SuggestionStatus,
  ): Promise<LivingDocSuggestion | null>;
}

export class InMemoryLivingDocMetadataStore implements LivingDocMetadataStore {
  private readonly docs = new Map<string, LivingDoc>();
  private readonly versions: LivingDocVersion[] = [];
  private readonly comments: LivingDocComment[] = [];
  private readonly suggestions: LivingDocSuggestion[] = [];
  private readonly now: () => Date;

  constructor(options: ClockOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateLivingDocInput): Promise<LivingDoc> {
    const timestamp = this.now();
    const doc: LivingDoc = {
      opaqueId: input.opaqueId,
      reviewId: input.reviewId,
      publisherEmail: input.publisherEmail,
      status: input.status ?? "active",
      title: input.title ?? null,
      currentMarkdown: input.currentMarkdown,
      latestVersionNumber: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      removedAt: null,
    };
    this.docs.set(doc.opaqueId, doc);
    return cloneDoc(doc);
  }

  async getByOpaqueId(opaqueId: string): Promise<LivingDoc | null> {
    const doc = this.docs.get(opaqueId);
    return doc ? cloneDoc(doc) : null;
  }

  async getByReviewId(reviewId: string): Promise<LivingDoc | null> {
    const doc = [...this.docs.values()].find((d) => d.reviewId === reviewId);
    return doc ? cloneDoc(doc) : null;
  }

  async updateMarkdown(
    opaqueId: string,
    markdown: string,
  ): Promise<LivingDoc | null> {
    const doc = this.docs.get(opaqueId);
    if (!doc) return null;
    const next = { ...doc, currentMarkdown: markdown, updatedAt: this.now() };
    this.docs.set(opaqueId, next);
    return cloneDoc(next);
  }

  async setLatestVersionNumber(
    opaqueId: string,
    versionNumber: number,
  ): Promise<LivingDoc | null> {
    const doc = this.docs.get(opaqueId);
    if (!doc) return null;
    const next = {
      ...doc,
      latestVersionNumber: versionNumber,
      updatedAt: this.now(),
    };
    this.docs.set(opaqueId, next);
    return cloneDoc(next);
  }

  async markRemoved(opaqueId: string): Promise<LivingDoc | null> {
    const doc = this.docs.get(opaqueId);
    if (!doc) return null;
    const timestamp = this.now();
    const next: LivingDoc = {
      ...doc,
      status: "removed",
      removedAt: timestamp,
      updatedAt: timestamp,
    };
    this.docs.set(opaqueId, next);
    return cloneDoc(next);
  }

  async listByPublisherEmail(publisherEmail: string): Promise<LivingDoc[]> {
    return [...this.docs.values()]
      .filter((doc) => doc.publisherEmail === publisherEmail)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(cloneDoc);
  }

  async addVersion(input: CreateVersionInput): Promise<LivingDocVersion> {
    const version: LivingDocVersion = {
      id: input.id,
      livingDocId: input.livingDocId,
      versionNumber: input.versionNumber,
      markdown: input.markdown,
      createdAt: this.now(),
    };
    this.versions.push(version);
    return cloneVersion(version);
  }

  async getVersion(
    opaqueId: string,
    versionNumber: number,
  ): Promise<LivingDocVersion | null> {
    const version = this.versions.find(
      (v) => v.livingDocId === opaqueId && v.versionNumber === versionNumber,
    );
    return version ? cloneVersion(version) : null;
  }

  async addComment(input: CreateCommentInput): Promise<LivingDocComment> {
    const comment: LivingDocComment = {
      id: input.id,
      livingDocId: input.livingDocId,
      origin: input.origin,
      author: input.author ?? null,
      anchorQuote: input.anchorQuote,
      anchorStart: input.anchorStart ?? null,
      anchorEnd: input.anchorEnd ?? null,
      body: input.body,
      parentCommentId: input.parentCommentId ?? null,
      status: "open",
      createdAt: this.now(),
    };
    this.comments.push(comment);
    return cloneComment(comment);
  }

  async listComments(
    opaqueId: string,
    options: { status?: CommentStatus } = {},
  ): Promise<LivingDocComment[]> {
    return this.comments
      .filter(
        (comment) =>
          comment.livingDocId === opaqueId &&
          (options.status ? comment.status === options.status : true),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(cloneComment);
  }

  async setCommentStatus(
    commentId: string,
    status: CommentStatus,
  ): Promise<LivingDocComment | null> {
    const comment = this.comments.find((c) => c.id === commentId);
    if (!comment) return null;
    comment.status = status;
    return cloneComment(comment);
  }

  async addSuggestion(
    input: CreateSuggestionInput,
  ): Promise<LivingDocSuggestion> {
    const suggestion: LivingDocSuggestion = {
      id: input.id,
      livingDocId: input.livingDocId,
      versionNumber: input.versionNumber,
      anchorQuote: input.anchorQuote,
      anchorStart: input.anchorStart ?? null,
      anchorEnd: input.anchorEnd ?? null,
      replacement: input.replacement,
      note: input.note ?? null,
      status: "pending",
      createdAt: this.now(),
      resolvedAt: null,
    };
    this.suggestions.push(suggestion);
    return cloneSuggestion(suggestion);
  }

  async listSuggestions(
    opaqueId: string,
    options: { status?: SuggestionStatus } = {},
  ): Promise<LivingDocSuggestion[]> {
    return this.suggestions
      .filter(
        (suggestion) =>
          suggestion.livingDocId === opaqueId &&
          (options.status ? suggestion.status === options.status : true),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(cloneSuggestion);
  }

  async setSuggestionStatus(
    suggestionId: string,
    status: SuggestionStatus,
  ): Promise<LivingDocSuggestion | null> {
    const suggestion = this.suggestions.find((s) => s.id === suggestionId);
    if (!suggestion) return null;
    suggestion.status = status;
    suggestion.resolvedAt = status === "pending" ? null : this.now();
    return cloneSuggestion(suggestion);
  }
}

export class PostgresLivingDocMetadataStore implements LivingDocMetadataStore {
  private readonly now: () => Date;

  constructor(
    private readonly sql: SqlClient,
    options: ClockOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateLivingDocInput): Promise<LivingDoc> {
    const timestamp = this.now();
    const result = await this.sql.query<LivingDocRow>(
      `
        insert into living_docs (
          opaque_id, review_id, publisher_email, status, title,
          current_markdown, latest_version_number, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, 0, $7, $7)
        returning *
      `,
      [
        input.opaqueId,
        input.reviewId,
        input.publisherEmail,
        input.status ?? "active",
        input.title ?? null,
        input.currentMarkdown,
        timestamp,
      ],
    );
    return mapDocRow(result.rows[0]);
  }

  async getByOpaqueId(opaqueId: string): Promise<LivingDoc | null> {
    const result = await this.sql.query<LivingDocRow>(
      "select * from living_docs where opaque_id = $1",
      [opaqueId],
    );
    return result.rows[0] ? mapDocRow(result.rows[0]) : null;
  }

  async getByReviewId(reviewId: string): Promise<LivingDoc | null> {
    const result = await this.sql.query<LivingDocRow>(
      "select * from living_docs where review_id = $1",
      [reviewId],
    );
    return result.rows[0] ? mapDocRow(result.rows[0]) : null;
  }

  async updateMarkdown(
    opaqueId: string,
    markdown: string,
  ): Promise<LivingDoc | null> {
    const result = await this.sql.query<LivingDocRow>(
      `
        update living_docs
        set current_markdown = $2, updated_at = $3
        where opaque_id = $1
        returning *
      `,
      [opaqueId, markdown, this.now()],
    );
    return result.rows[0] ? mapDocRow(result.rows[0]) : null;
  }

  async setLatestVersionNumber(
    opaqueId: string,
    versionNumber: number,
  ): Promise<LivingDoc | null> {
    const result = await this.sql.query<LivingDocRow>(
      `
        update living_docs
        set latest_version_number = $2, updated_at = $3
        where opaque_id = $1
        returning *
      `,
      [opaqueId, versionNumber, this.now()],
    );
    return result.rows[0] ? mapDocRow(result.rows[0]) : null;
  }

  async markRemoved(opaqueId: string): Promise<LivingDoc | null> {
    const timestamp = this.now();
    const result = await this.sql.query<LivingDocRow>(
      `
        update living_docs
        set status = 'removed', removed_at = $2, updated_at = $2
        where opaque_id = $1
        returning *
      `,
      [opaqueId, timestamp],
    );
    return result.rows[0] ? mapDocRow(result.rows[0]) : null;
  }

  async listByPublisherEmail(publisherEmail: string): Promise<LivingDoc[]> {
    const result = await this.sql.query<LivingDocRow>(
      "select * from living_docs where publisher_email = $1 order by updated_at desc",
      [publisherEmail],
    );
    return result.rows.map(mapDocRow);
  }

  async addVersion(input: CreateVersionInput): Promise<LivingDocVersion> {
    const result = await this.sql.query<LivingDocVersionRow>(
      `
        insert into living_doc_versions (
          id, living_doc_id, version_number, markdown, created_at
        ) values ($1, $2, $3, $4, $5)
        returning *
      `,
      [
        input.id,
        input.livingDocId,
        input.versionNumber,
        input.markdown,
        this.now(),
      ],
    );
    return mapVersionRow(result.rows[0]);
  }

  async getVersion(
    opaqueId: string,
    versionNumber: number,
  ): Promise<LivingDocVersion | null> {
    const result = await this.sql.query<LivingDocVersionRow>(
      "select * from living_doc_versions where living_doc_id = $1 and version_number = $2",
      [opaqueId, versionNumber],
    );
    return result.rows[0] ? mapVersionRow(result.rows[0]) : null;
  }

  async addComment(input: CreateCommentInput): Promise<LivingDocComment> {
    const result = await this.sql.query<LivingDocCommentRow>(
      `
        insert into living_doc_comments (
          id, living_doc_id, origin, author, anchor_quote,
          anchor_start, anchor_end, body, parent_comment_id, status, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10)
        returning *
      `,
      [
        input.id,
        input.livingDocId,
        input.origin,
        input.author ?? null,
        input.anchorQuote,
        input.anchorStart ?? null,
        input.anchorEnd ?? null,
        input.body,
        input.parentCommentId ?? null,
        this.now(),
      ],
    );
    return mapCommentRow(result.rows[0]);
  }

  async listComments(
    opaqueId: string,
    options: { status?: CommentStatus } = {},
  ): Promise<LivingDocComment[]> {
    const result = options.status
      ? await this.sql.query<LivingDocCommentRow>(
          "select * from living_doc_comments where living_doc_id = $1 and status = $2 order by created_at",
          [opaqueId, options.status],
        )
      : await this.sql.query<LivingDocCommentRow>(
          "select * from living_doc_comments where living_doc_id = $1 order by created_at",
          [opaqueId],
        );
    return result.rows.map(mapCommentRow);
  }

  async setCommentStatus(
    commentId: string,
    status: CommentStatus,
  ): Promise<LivingDocComment | null> {
    const result = await this.sql.query<LivingDocCommentRow>(
      "update living_doc_comments set status = $2 where id = $1 returning *",
      [commentId, status],
    );
    return result.rows[0] ? mapCommentRow(result.rows[0]) : null;
  }

  async addSuggestion(
    input: CreateSuggestionInput,
  ): Promise<LivingDocSuggestion> {
    const result = await this.sql.query<LivingDocSuggestionRow>(
      `
        insert into living_doc_suggestions (
          id, living_doc_id, version_number, anchor_quote, anchor_start,
          anchor_end, replacement, note, status, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
        returning *
      `,
      [
        input.id,
        input.livingDocId,
        input.versionNumber,
        input.anchorQuote,
        input.anchorStart ?? null,
        input.anchorEnd ?? null,
        input.replacement,
        input.note ?? null,
        this.now(),
      ],
    );
    return mapSuggestionRow(result.rows[0]);
  }

  async listSuggestions(
    opaqueId: string,
    options: { status?: SuggestionStatus } = {},
  ): Promise<LivingDocSuggestion[]> {
    const result = options.status
      ? await this.sql.query<LivingDocSuggestionRow>(
          "select * from living_doc_suggestions where living_doc_id = $1 and status = $2 order by created_at",
          [opaqueId, options.status],
        )
      : await this.sql.query<LivingDocSuggestionRow>(
          "select * from living_doc_suggestions where living_doc_id = $1 order by created_at",
          [opaqueId],
        );
    return result.rows.map(mapSuggestionRow);
  }

  async setSuggestionStatus(
    suggestionId: string,
    status: SuggestionStatus,
  ): Promise<LivingDocSuggestion | null> {
    const resolvedAt = status === "pending" ? null : this.now();
    const result = await this.sql.query<LivingDocSuggestionRow>(
      "update living_doc_suggestions set status = $2, resolved_at = $3 where id = $1 returning *",
      [suggestionId, status, resolvedAt],
    );
    return result.rows[0] ? mapSuggestionRow(result.rows[0]) : null;
  }
}

export function createNeonLivingDocMetadataStore(
  databaseUrl = requiredEnv("DATABASE_URL"),
): PostgresLivingDocMetadataStore {
  const sql = neon(databaseUrl);
  return new PostgresLivingDocMetadataStore({
    async query<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) {
      const rows = (await sql.query(text, params)) as T[];
      return { rows };
    },
  });
}

interface LivingDocRow {
  opaque_id: string;
  review_id: string;
  publisher_email: string;
  status: LivingDocStatus;
  title: string | null;
  current_markdown: string;
  latest_version_number: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  removed_at: Date | string | null;
}

interface LivingDocVersionRow {
  id: string;
  living_doc_id: string;
  version_number: number | string;
  markdown: string;
  created_at: Date | string;
}

interface LivingDocCommentRow {
  id: string;
  living_doc_id: string;
  origin: CommentOrigin;
  author: string | null;
  anchor_quote: string;
  anchor_start: number | string | null;
  anchor_end: number | string | null;
  body: string;
  parent_comment_id: string | null;
  status: CommentStatus;
  created_at: Date | string;
}

interface LivingDocSuggestionRow {
  id: string;
  living_doc_id: string;
  version_number: number | string;
  anchor_quote: string;
  anchor_start: number | string | null;
  anchor_end: number | string | null;
  replacement: string;
  note: string | null;
  status: SuggestionStatus;
  created_at: Date | string;
  resolved_at: Date | string | null;
}

function mapDocRow(row: LivingDocRow | undefined): LivingDoc {
  if (!row) throw new Error("Expected Living Doc row");
  return {
    opaqueId: row.opaque_id,
    reviewId: row.review_id,
    publisherEmail: row.publisher_email,
    status: row.status,
    title: row.title ?? null,
    currentMarkdown: row.current_markdown,
    latestVersionNumber: Number(row.latest_version_number),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    removedAt: row.removed_at ? new Date(row.removed_at) : null,
  };
}

function mapVersionRow(row: LivingDocVersionRow | undefined): LivingDocVersion {
  if (!row) throw new Error("Expected Living Doc Version row");
  return {
    id: row.id,
    livingDocId: row.living_doc_id,
    versionNumber: Number(row.version_number),
    markdown: row.markdown,
    createdAt: new Date(row.created_at),
  };
}

function mapCommentRow(row: LivingDocCommentRow | undefined): LivingDocComment {
  if (!row) throw new Error("Expected Living Doc Comment row");
  return {
    id: row.id,
    livingDocId: row.living_doc_id,
    origin: row.origin,
    author: row.author ?? null,
    anchorQuote: row.anchor_quote,
    anchorStart: row.anchor_start === null ? null : Number(row.anchor_start),
    anchorEnd: row.anchor_end === null ? null : Number(row.anchor_end),
    body: row.body,
    parentCommentId: row.parent_comment_id ?? null,
    status: row.status,
    createdAt: new Date(row.created_at),
  };
}

function mapSuggestionRow(
  row: LivingDocSuggestionRow | undefined,
): LivingDocSuggestion {
  if (!row) throw new Error("Expected Living Doc Suggestion row");
  return {
    id: row.id,
    livingDocId: row.living_doc_id,
    versionNumber: Number(row.version_number),
    anchorQuote: row.anchor_quote,
    anchorStart: row.anchor_start === null ? null : Number(row.anchor_start),
    anchorEnd: row.anchor_end === null ? null : Number(row.anchor_end),
    replacement: row.replacement,
    note: row.note ?? null,
    status: row.status,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
  };
}

function cloneDoc(doc: LivingDoc): LivingDoc {
  return {
    ...doc,
    createdAt: new Date(doc.createdAt),
    updatedAt: new Date(doc.updatedAt),
    removedAt: doc.removedAt ? new Date(doc.removedAt) : null,
  };
}

function cloneVersion(version: LivingDocVersion): LivingDocVersion {
  return { ...version, createdAt: new Date(version.createdAt) };
}

function cloneComment(comment: LivingDocComment): LivingDocComment {
  return { ...comment, createdAt: new Date(comment.createdAt) };
}

function cloneSuggestion(suggestion: LivingDocSuggestion): LivingDocSuggestion {
  return {
    ...suggestion,
    createdAt: new Date(suggestion.createdAt),
    resolvedAt: suggestion.resolvedAt ? new Date(suggestion.resolvedAt) : null,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
