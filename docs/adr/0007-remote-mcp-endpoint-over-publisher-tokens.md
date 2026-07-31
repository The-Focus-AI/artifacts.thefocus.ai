# The MCP surface is a remote /mcp endpoint authenticated by Publisher Tokens

## Status

proposed

## Decision

We are adding **`https://artifacts.thefocus.ai/mcp`**: a remote MCP server exposing
publishing and the Living Doc loop as tools, authenticated by the same Publisher Token
the CLI uses, sent as `Authorization: Bearer`. It is **additive** — the CLI remains the
primary surface and loses nothing. `ADR-0005` deferred exactly this: _"An MCP wrapper
over the same API is a later, additive surface."_

There is **no local (stdio) MCP server**. The endpoint is remote only.

## What we took from the standards, and what we did not

TheFocus.AI standards have no standalone MCP standard. The guidance lives in
`STD-010-agent-services.md` (normative, `applies-to: A2A-discoverable agent services`)
and the walkthrough in `best-practices/GDE-001-a2a-agent.md` §7. Artifacts is not an
agent service — it has no LLM in the loop, makes no quantitative claims, and holds no
conversation — so most of STD-010 is out of scope by its own `applies-to`. Two clauses
carry over as shape rules and we follow them:

- **§3.1** — every tool is a mutation or a discovery tool, never both. The other half of
  §3.1, the "visual tool" carrying a citation and a UI resource, has no analogue here:
  these tools return Publication URLs and Living Doc state, not claims about a dataset.
  We deliberately do **not** manufacture citations to satisfy a clause that does not apply.
- **§3.2** — a tool is defined once and projected to every surface. `src/mcp/tools.ts` is
  the single catalog; `registerToolOnMcpServer` is the only projection.

We did **not** adopt §3.3 (typed refusals), §3.4 (citations), §3.5 (system prompt as
markdown), or §3.6 (Postgres session persistence). Those exist because an agent service
answers questions about data; a publishing service does not.

From GDE-001 §7 we took the transport recipe — `@modelcontextprotocol/sdk` (pinned at
`1.30.0`, matching the guide's current pin), `WebStandardStreamableHTTPServerTransport`,
stateless with `sessionIdGenerator: undefined`, one server built per request.

**One deviation from GDE-001 §7:** we set `enableJsonResponse: true`. GDE-001 assumes an
SSE stream, but `writeWebResponseToNodeResponse` buffers a whole response through
`arrayBuffer()`, so an SSE stream would be held rather than streamed. Nothing in this
catalog sends server-initiated notifications, so JSON responses are the honest shape.
`GET /mcp` (the SSE listen channel) returns 405 and `DELETE` returns 204.

## The tools

Mutations: `publish_artifact`, `update_artifact`, `remove_artifact`, `publish_doc`,
`pull_doc`, `respond_doc`, `remove_doc`. Discovery: `list_artifacts`, `list_docs`,
`whoami`.

`pull_doc` is classed as a mutation despite reading like a query — it cuts an immutable
Version, which is a state change both parties can later refer back to.

## Considered options and why they were rejected

- **Remote endpoint over a local stdio server.** Remote was the requirement. It costs two
  things and we accept both. (1) Artifacts must be sent inline — the server cannot read
  the caller's disk — so `publish_artifact` takes `html` or a `files[]` array, and the
  practical ceiling is the platform request body limit, well under the 25 MB/100 MB
  preflight numbers. This is for pages and small bundles; large directories stay on the
  CLI. (2) The **Revision Window cannot apply**: it is keyed to a Local Source path held
  in the Publisher's config directory, and there is none here.
- **`update_artifact` as its own tool rather than a flag on `publish_artifact`.** Follows
  from the above. Over MCP there is no implicit "same source, same URL", so updating must
  be explicit: the caller carries the Publication URL from the publish result into the
  update call. This is a real behavioural difference from `artifacts publish` and is
  stated in both tool descriptions.
- **A distinct `mcp` Publisher Token kind, revocable.** Chosen over reusing the single
  existing token unchanged. Publisher Tokens were designed to live in one config file
  with restricted permissions; an MCP credential gets pasted into client config that is
  often committed or synced. Before this change the token table had no expiry and no
  revocation — `artifacts logout` clears local state only, so a leaked token was valid
  forever. `mcp`-kind tokens (`tfai_mcp_…`) are minted explicitly, listed, and revoked
  independently, so killing one does not log the Publisher out of the CLI. Revocation is
  by **Token Id**, a 12-character prefix of the stored SHA-256 hash — safe to print,
  useless for authenticating, and the only handle that survives a token being shown once.
  Both kinds are accepted on `/mcp`: an existing `tfai_pub_…` token keeps working.
- **Static bearer over OAuth 2.1, for now.** A Publisher Token is bearer-_shaped_ but is
  not an OAuth token: not issued by an authorization server, not audience-bound
  (RFC 8707), no expiry. The consequence is concrete: clients that let you set a header
  (Claude Code, `.mcp.json`, Cursor, SDK clients) work today; browser connector UIs that
  only run the OAuth discovery dance do not. We accept that, because the requirement was
  parity with the CLI's credential. The endpoint returns `WWW-Authenticate: Bearer` with
  a typed `error`/`error_description` on 401 so a client can distinguish "no credential"
  from "bad credential" without parsing prose.

## Consequences

- **If we later put a real authorization server in front of `/mcp`, it must advertise
  `client_id_metadata_document_supported`.** `STD-009` R2 §3.12 tells every Focus product
  acting as an OAuth client to prefer Client ID Metadata Documents and treat Dynamic
  Client Registration as a deprecated fallback. Our own clients would be bound by that
  clause when connecting here, so choosing a DCR-only authorization server would put this
  service out of step with our own standard on day one. §3.10–3.12 do not otherwise bind
  this endpoint: they govern software acting as an OAuth _client_, and here we are the
  resource server.
- Serving RFC 9728 Protected Resource Metadata at
  `/.well-known/oauth-protected-resource` is the phase-2 artifact that turns this same
  endpoint into a conformant OAuth resource server without moving it. Not written yet;
  it should be written against the current spec text rather than from memory.
- `authenticatePublisherToken` no longer writes `last_used_at` on every call. MCP is
  chatty — an `initialize`, a `tools/list`, then a write per `tools/call` — and last-used
  is diagnostic, not a security control, so writes are throttled to once an hour per
  token. Revocation is unaffected and takes effect on the next request.
- `migrations/0006_add_publisher_token_kind_and_revocation.sql` must run before deploy.
  It is additive and backfills every existing row to `kind = 'cli'`.
