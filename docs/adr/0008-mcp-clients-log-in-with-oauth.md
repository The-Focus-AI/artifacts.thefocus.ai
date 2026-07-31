# MCP clients log in with OAuth, and Artifacts is its own authorization server

## Status

proposed

## Context

`ADR-0007` shipped `/mcp` authenticated by a pasted Publisher Token. That works
for clients that let you set a header, but it is not logging in: there is no
browser flow, and a hosted client that only performs OAuth discovery cannot
connect at all. This decision adds the login.

## Decision

Artifacts acts as its **own OAuth 2.1 authorization server**, with `/mcp` as the
protected resource. A client discovers the flow from a 401, registers, sends the
Publisher to a browser consent page, and exchanges a code for an access token.
No token is ever pasted by hand.

The endpoints:

| Route                                         | Purpose                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 — names the resource and its authorization server |
| `/.well-known/oauth-authorization-server`     | RFC 8414 — endpoints, PKCE methods, supported grants       |
| `/oauth/authorize`                            | Consent, gated on a Clerk browser session                  |
| `/oauth/token`                                | Authorization-code and refresh-token grants                |
| `/oauth/register`                             | Dynamic Client Registration (compatibility path)           |

The 401 from `/mcp` now carries
`WWW-Authenticate: Bearer error="…", resource_metadata="…"`, which is the thread
a client pulls to find all of the above.

**Human authentication is delegated to the existing Clerk login.** `/oauth/authorize`
resolves the browser's Clerk session with the same `ClerkVerifier` the CLI login
uses, and applies the same `@thefocus.ai` restriction. Artifacts owns the OAuth
protocol; Clerk owns "who is this person". No new identity system.

**Both credentials work on `/mcp`.** An OAuth access token (`tfai_at_…`) or a
Publisher Token (`tfai_mcp_…` / `tfai_pub_…`). The prefix selects which store to
check, so a malformed credential is never tried against both.

## Considered options and why they were rejected

- **Artifacts as the authorization server, over delegating to Clerk's OAuth.**
  Clerk can act as an authorization server, but that puts the resource's scopes,
  consent copy, and client registration behind dashboard configuration we cannot
  test or review in this repo, and it would still need a mapping from Clerk
  tokens to Publisher identity. Running the protocol here keeps the whole flow in
  version control and testable end to end, and reuses the `@thefocus.ai` rule
  already written down. Clerk still authenticates the human.
- **Client ID Metadata Documents first, Dynamic Client Registration as fallback.**
  `STD-009` R2 §3.12 tells Focus clients to prefer CIMD because the MCP spec
  deprecated DCR, so an authorization server of ours that only spoke DCR would
  force our own clients onto the deprecated path. The metadata advertises
  `client_id_metadata_document_supported: true`. A `client_id` that is an https
  URL with a path is fetched and validated: per §3.10 the document's `client_id`
  must equal its own URL exactly, or it is rejected. `/oauth/register` remains
  because today's clients — including the MCP SDK's own client — still use it.
- **Public clients with PKCE, no client secrets.** MCP clients are native and
  browser applications that cannot hold a secret. `code_challenge_method=S256`
  is required; `plain` is rejected. PKCE is what binds a code to the client that
  requested it.
- **Audience-bound tokens.** The `resource` parameter (RFC 8707) is recorded on
  the code and carried onto the token, and `/mcp` refuses a token issued for a
  different resource. Without this an access token minted for some other service
  by the same authorization server would be replayable here.
- **Rotating refresh tokens.** A refresh token is single-use: refreshing revokes
  the old one. A stolen refresh token then surfaces as the legitimate client's
  next refresh failing, rather than as silent parallel access.
- **Consent is a POST guarded by an origin check.** The approval acts on the
  browser's Clerk session, so a cross-site auto-submitting form could otherwise
  approve a client the Publisher never saw. The check compares the `Origin`
  header's **host** to the request's `Host` — not the full origin, because behind
  a TLS-terminating proxy the scheme is reconstructed from `x-forwarded-proto`
  and a scheme comparison would reject legitimate submissions.
- **Errors before client validation render a page; errors after it redirect.**
  Until `client_id` and `redirect_uri` are known good there is nowhere safe to
  send an error, so a bad client gets an HTML page, never a redirect.

## Consequences

- `migrations/0007_create_oauth_tables.sql` must run before deploy: clients,
  authorization codes, and tokens. Codes are single-use, enforced by a
  conditional `update … where consumed_at is null` rather than a read-then-write,
  so a replayed code cannot mint a second token even under a race.
- Access tokens live an hour, refresh tokens thirty days, authorization codes
  one minute. Expired rows are left in place; a cleanup job is not written yet
  and will be wanted once the tables have real traffic.
- `removePublication` now accepts an already-authenticated `publisherEmail`
  instead of requiring a Publisher Token, because an OAuth caller has no such
  token. Its existing behaviour is otherwise unchanged — removal remains
  team-wide, which `tests/remove.test.ts` asserts by name.
- The MCP tool context no longer carries the raw credential, only the
  authenticated Publisher. Tools cannot tell which credential was used, which is
  the point.
- There is still no token-revocation endpoint (RFC 7009) and no consent screen
  for reviewing previously approved clients. `artifacts token list`/`revoke`
  covers Publisher Tokens only. Worth adding once real clients are connected.
