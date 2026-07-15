import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface SplitFrontMatter {
  /** Raw YAML between the opening/closing `---` fences, or null if none. */
  matter: string | null;
  body: string;
}

// Opening fence at the start of the file, then YAML, then a closing fence.
const FRONT_MATTER_RE =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/**
 * Split Markdown into optional YAML front matter and the body.
 * Preserves the exact matter text so editors can round-trip without reformat.
 */
export function splitFrontMatter(markdown: string): SplitFrontMatter {
  const match = markdown.match(FRONT_MATTER_RE);
  if (!match) return { matter: null, body: markdown };
  return { matter: match[1], body: match[2] ?? "" };
}

/**
 * Reassemble Markdown from optional front matter and body.
 * Empty/whitespace-only matter drops the fences entirely.
 */
export function joinFrontMatter(matter: string | null, body: string): string {
  if (matter === null) return body;
  const trimmed = matter.replace(/^\uFEFF/, "").replace(/\s+$/, "");
  if (trimmed.length === 0) return body;
  const bodyPart = body.replace(/^\r?\n/, "");
  return `---\n${trimmed}\n---\n${bodyPart}`;
}

/** Parse front-matter YAML into a plain object, or null if missing/invalid. */
export function parseFrontMatterData(
  matter: string | null,
): Record<string, unknown> | null {
  if (matter === null) return null;
  try {
    const data = parseYaml(matter);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Prefer a string `title` from front matter when present. */
export function titleFromFrontMatter(matter: string | null): string | null {
  const data = parseFrontMatterData(matter);
  if (!data) return null;
  const title = data.title;
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

/**
 * Title for a Living Doc: front-matter `title`, else first heading/line in the
 * body (front matter itself is never used as the title).
 */
export function deriveMarkdownTitle(markdown: string): string | null {
  const { matter, body } = splitFrontMatter(markdown);
  const fromMatter = titleFromFrontMatter(matter);
  if (fromMatter) return fromMatter;

  for (const line of body.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) return heading[1].slice(0, 200);
    if (line.trim().length > 0) return line.trim().slice(0, 200);
  }
  return null;
}

/** Body only — safe to feed to markdown-it / TipTap. */
export function markdownBody(markdown: string): string {
  return splitFrontMatter(markdown).body;
}

/** Serialize a plain object back to YAML suitable for front-matter fences. */
export function serializeFrontMatterData(
  data: Record<string, unknown>,
): string {
  return stringifyYaml(data, { lineWidth: 0 }).replace(/\n$/, "");
}

/**
 * Parse a single field value from the front-matter editor.
 * Prefer YAML scalars/collections; fall back to the raw string.
 */
export function parseFrontMatterFieldValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  try {
    return parseYaml(trimmed);
  } catch {
    return raw;
  }
}

/** Format a value for display in a single-line field editor. */
export function formatFrontMatterFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return stringifyYaml(value, { lineWidth: 0 }).replace(/\n$/, "");
}
