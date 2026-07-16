/**
 * YAML front matter helpers for Living Docs.
 * Stored Markdown always keeps front matter; callers may split it only for
 * display (View HTML) or title derivation — never discard it on publish/save.
 */

export interface SplitFrontMatter {
  matter: string | null;
  body: string;
}

const FRONT_MATTER_RE =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export function splitFrontMatter(markdown: string): SplitFrontMatter {
  const match = markdown.match(FRONT_MATTER_RE);
  if (!match) return { matter: null, body: markdown };
  return { matter: match[1], body: match[2] ?? "" };
}

export function joinFrontMatter(matter: string | null, body: string): string {
  if (matter === null) return body;
  const trimmed = matter.replace(/^\uFEFF/, "").replace(/\s+$/, "");
  if (trimmed.length === 0) return body;
  const bodyPart = body.replace(/^\r?\n/, "");
  return `---\n${trimmed}\n---\n${bodyPart}`;
}

export function markdownBody(markdown: string): string {
  return splitFrontMatter(markdown).body;
}

/** Prefer a string `title:` from front matter when present. */
export function titleFromFrontMatter(matter: string | null): string | null {
  if (matter === null) return null;
  const match = matter.match(/^title:\s*(.+)$/m);
  if (!match?.[1]) return null;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value.slice(0, 200) : null;
}

/**
 * Title for a Living Doc: front-matter `title`, else first heading/line in the
 * body. Front matter fences themselves are never used as the title.
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
