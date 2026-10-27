// Link previews (Slack, iMessage, Teams, X) read Open Graph meta tags from
// the Entry Page. Agent-created HTML rarely has them, so the server adds a
// text card at serve time. Tags the author already set always win. The card
// carries no image or brand copy: Publications can be served from any
// domain, so the site name is the host the request came in on.

export interface OpenGraphCard {
  title: string;
  description: string | null;
  url: string;
  siteName: string;
}

export function openGraphMetaTags(card: OpenGraphCard): string {
  const tags: Array<[string, string, string]> = [
    ["property", "og:title", card.title],
    ["property", "og:url", card.url],
    ["property", "og:type", "website"],
    ["property", "og:site_name", card.siteName],
    ["name", "twitter:card", "summary"],
    ["name", "twitter:title", card.title],
  ];
  if (card.description) {
    tags.splice(1, 0, ["property", "og:description", card.description]);
    tags.push(["name", "twitter:description", card.description]);
  }
  return tags
    .map(
      ([attribute, key, value]) =>
        `<meta ${attribute}="${key}" content="${escapeHtmlAttribute(value)}" />`,
    )
    .join("\n");
}

export function hasOpenGraphTitle(html: string): boolean {
  return /<meta[^>]+property=["']og:title["']/i.test(html);
}

export function injectOpenGraphTags(
  html: string,
  card: { title: string | null; url: string; siteName: string },
): string {
  if (hasOpenGraphTitle(html)) return html;
  const block = openGraphMetaTags({
    title: card.title ?? extractHtmlTitle(html) ?? card.siteName,
    description: extractHtmlMetaDescription(html),
    url: card.url,
    siteName: card.siteName,
  });

  const headClose = html.search(/<\/head\s*>/i);
  if (headClose >= 0) return insertAt(html, headClose, `${block}\n`);
  for (const pattern of [
    /<head(?:\s[^>]*)?>/i,
    /<html(?:\s[^>]*)?>/i,
    /<!doctype[^>]*>/i,
  ]) {
    const match = html.match(pattern);
    if (match?.index !== undefined) {
      return insertAt(html, match.index + match[0].length, `\n${block}`);
    }
  }
  return `${block}\n${html}`;
}

export function extractHtmlTitle(input: string | Buffer): string | null {
  const s = typeof input === "string" ? input : input.toString("utf8");
  // Match the first <title>...</title>, case-insensitive, capture inner text
  const match = s.match(/<title[^>]*>\s*([\s\S]*?)\s*<\/title>/i);
  if (!match) return null;
  const title = decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim());
  return title.length > 0 ? title.slice(0, 200) : null;
}

export function extractHtmlMetaDescription(html: string): string | null {
  const tag = html.match(/<meta\s[^>]*name=["']description["'][^>]*>/i);
  if (!tag) return null;
  const content = tag[0].match(/content=(?:"([^"]*)"|'([^']*)')/i);
  const value = content?.[1] ?? content?.[2];
  if (!value) return null;
  const description = decodeHtmlEntities(value.replace(/\s+/g, " ").trim());
  return description.length > 0 ? description.slice(0, 300) : null;
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function insertAt(html: string, index: number, text: string): string {
  return `${html.slice(0, index)}${text}${html.slice(index)}`;
}
