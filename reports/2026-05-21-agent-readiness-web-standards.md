# Agent-readiness web standards implementation report

## Abstract

This report summarizes low-risk changes that help a small static/API website perform better on isitagentready.com and similar agent-readiness scanners. The most relevant checks for `artifacts.thefocus.ai` are discoverability (`robots.txt`, sitemap, `Link` headers), content accessibility (Markdown negotiation and `llms.txt`), and bot access policy (`Content-Signal` and AI crawler rules). Protocol and commerce checks such as MCP, OAuth protected-resource discovery, x402, MPP, UCP, and ACP are not appropriate for this v1 unlisted static publishing service until it exposes a public agent API or paid resources.

## Findings

### Scanner categories

Cloudflare describes isitagentready.com as checking multiple emerging standards: discoverability through `robots.txt`, sitemap, and `Link` headers; content accessibility through Markdown content negotiation; bot access control through AI bot rules, Content Signals, and Web Bot Auth; protocol discovery through MCP, Agent Skills, WebMCP, API Catalog, and OAuth metadata; and commerce through x402/MPP/UCP/ACP. For this service, the first three categories are immediately actionable without adding a public dashboard or broadening access to unlisted Publications.

### Discoverability

The scanner and Cloudflare announcement emphasize that agents look first at `robots.txt`, where they expect crawl directives and `Sitemap:` references. The same announcement highlights RFC 8288 `Link` response headers as a machine-readable way to point agents at important resources without parsing HTML.

Recommended implementation for this repo:

- Keep `/a/` disallowed because Publication URLs are unlisted and client-facing Artifacts should not be crawled.
- Add `Sitemap: https://artifacts.thefocus.ai/sitemap.xml` to `robots.txt`.
- Add a small `public/sitemap.xml` for root service resources only; do not enumerate Publications.
- Add Vercel `Link` headers from `/` to `/sitemap.xml`, `/llms.txt`, and `/index.md`.

### Content accessibility

Cloudflare’s Markdown for Agents documentation says agents request Markdown with `Accept: text/markdown`; Markdown responses should return `Content-Type: text/markdown; charset=utf-8` and `Vary: Accept`. Cloudflare also recommends URL fallbacks such as `/index.md` and `llms.txt` because not all agents send the negotiation header by default.

Recommended implementation for this repo:

- Add `public/index.md` as the canonical Markdown representation of the root landing page.
- Rewrite `/` to `/index.md` when `Accept` contains `text/markdown`.
- Add `public/llms.txt` with a concise site summary and links to the Markdown landing page, docs, robots, and sitemap.
- Add an HTML hint that tells agents to prefer `/index.md` or `Accept: text/markdown`.

### Bot access policy

Content Signals specifies a `Content-Signal` robots directive for `search`, `ai-input`, and `ai-train`. A good fit for `artifacts.thefocus.ai` is to allow search/index discovery for the root service page but reserve rights for model training and AI input reuse. Publications remain disallowed under `/a/`.

Recommended implementation for this repo:

- Add `Content-Signal: ai-train=no, search=yes, ai-input=no` under `User-agent: *`.
- Add explicit named AI crawler groups that disallow `/a/` while allowing root-level service resources.

## Decision

Implement only passive content/discovery standards in this slice. Do not add MCP, Agent Skills discovery, API Catalog, OAuth protected resource metadata, or commerce metadata yet; those would imply capabilities the service does not currently expose publicly and could confuse agents about unlisted Publication access.

## References

1. [Is Your Site Agent-Ready?](https://isitagentready.com/) — scanner categories and easy wins.
2. [Introducing the Agent Readiness score](https://blog.cloudflare.com/agent-readiness/) — rubric details for discoverability, content, bot access, capabilities, and commerce.
3. [Markdown for Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/) — `Accept: text/markdown`, `Content-Type`, `Vary: Accept`, and token-efficient Markdown output.
4. [Content Signals](https://contentsignals.org/) — `Content-Signal` robots directive syntax and policy meanings.
5. [Vercel vercel.json headers documentation](https://vercel.com/docs/project-configuration/vercel-json) — configuring response headers for static and dynamic routes.
