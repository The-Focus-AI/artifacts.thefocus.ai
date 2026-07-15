import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * Content negotiation for the root landing page.
 *
 * Vercel's header-conditional rewrites (`has` on the accept header)
 * proved unreliable in production — every request matched — so `/` is
 * rewritten here instead. Agents that ask for `Accept: text/markdown`
 * get the Markdown twin; everyone else gets the HTML landing page.
 */
export function wantsMarkdown(accept: string | undefined): boolean {
  return /\btext\/markdown\b/i.test(accept ?? "");
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const markdown = wantsMarkdown(request.headers.accept);
  const file = markdown ? "index.md" : "landing.html";
  const contentType = markdown
    ? "text/markdown; charset=utf-8"
    : "text/html; charset=utf-8";

  const body = await readFile(join(process.cwd(), "public", file));

  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Vary", "Accept");
  response.setHeader("Content-Signal", "ai-train=no, search=yes, ai-input=yes");
  response.setHeader(
    "Link",
    '</sitemap.xml>; rel="sitemap"; type="application/xml", </llms.txt>; rel="alternate"; type="text/plain", </index.md>; rel="alternate"; type="text/markdown"',
  );
  response.end(body);
}
