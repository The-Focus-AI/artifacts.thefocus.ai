# Agent-ready public docs research

## Question

How should `artifacts.thefocus.ai` present itself to AI agents, especially through `llms.txt`, Markdown negotiation, robots policy, and landing-page content?

## Findings

`isitagentready.com` checks five broad areas: discoverability, content accessibility, bot access control, protocol discovery, and commerce. For this service, the relevant high-value checks are discoverability and content accessibility: keep `robots.txt`, `sitemap.xml`, `Link` headers, `llms.txt`, and a Markdown representation of the root page accurate and useful.

The Cloudflare Markdown for Agents pattern uses HTTP content negotiation: agents can send `Accept: text/markdown`, and the site should return `Content-Type: text/markdown` content where practical. This project already rewrites `/` to `/index.md` when the request asks for Markdown, so the public Markdown needs to be as useful as the HTML landing page.

The `llms.txt` proposal recommends a root Markdown file that briefly explains the site and links to the most useful machine-readable resources. It should not be a full site dump; it should provide orientation, key usage examples, and links to detailed docs.

Cloudflare Content Signals let publishers declare preferences for use (`ai-train`, `search`, `ai-input`). For this service, the public docs should allow search and AI input because the goal is for agents to understand and use the publishing surface. Published client Artifact URLs under `/a/` should remain unlisted and disallowed from discovery.

## Implementation guidance

- Keep `/llms.txt` short, specific, and action-oriented for agents.
- Explain that the npm package is `@the-focus-ai/artifacts` and that the executable is `artifacts`.
- Provide copy-paste commands for publishing agent-created HTML files and directories.
- Tell agents not to crawl or enumerate `/a/` URLs.
- Keep `/index.md` aligned with the HTML landing page and make it useful when requested with `Accept: text/markdown`.
- Set public discovery headers and robots Content Signals to `ai-train=no, search=yes, ai-input=yes` so agents can use service docs as context without treating the service as training content.

## Sources

- Is It Agent Ready — https://isitagentready.com/
- Cloudflare Markdown for Agents — https://developers.cloudflare.com/changelog/2026-02-12-markdown-for-agents/
- Content Signals — https://contentsignals.org/
- llms.txt proposal — https://llmstxt.org/index.md
