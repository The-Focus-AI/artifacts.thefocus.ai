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
 *
 * The Markdown twin lives at `public/landing.md`, not `public/index.md`.
 * A static `index.md` in `public/` is treated as the directory index for
 * `/` and shadows this rewrite, so browsers always got Markdown.
 * The public `/index.md` URL is preserved via a rewrite to `/landing.md`.
 */
export function wantsMarkdown(accept: string | undefined): boolean {
  return /\btext\/markdown\b/i.test(accept ?? "");
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const markdown = wantsMarkdown(request.headers.accept);
  const file = markdown ? "landing.md" : "landing.html";
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
    '</sitemap.xml>; rel="sitemap"; type="application/xml", </llms.txt>; rel="alternate"; type="text/plain", </index.md>; rel="alternate"; type="text/markdown", </skill.md>; rel="describedby"; type="text/markdown"; title="artifacts skill", </skill-version.json>; rel="describedby"; type="application/json"; title="skill version", </.well-known/skills/index.json>; rel="describedby"; type="application/json"; title="well-known skills"',
  );
  response.end(body);
}
