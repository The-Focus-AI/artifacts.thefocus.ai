-- OAuth 2.1 authorization server state, so an MCP client can log in through
-- the browser instead of being handed a pasted Publisher Token.
-- See docs/adr/0008-mcp-clients-log-in-with-oauth.md.

-- Clients registered through Dynamic Client Registration. Clients identified by
-- a Client ID Metadata Document are resolved from their URL and are not stored.
create table if not exists oauth_clients (
    client_id text primary key,
    client_name text,
    redirect_uris jsonb not null,
    created_at timestamptz not null default now()
);

-- Short-lived authorization codes, bound to a PKCE challenge, a redirect URI,
-- and the resource the token will be audience-bound to.
create table if not exists oauth_authorization_codes (
    code_hash text primary key,
    client_id text not null,
    publisher_email text not null,
    redirect_uri text not null,
    code_challenge text not null,
    code_challenge_method text not null,
    scope text,
    resource text,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists oauth_authorization_codes_expires_at_idx
on oauth_authorization_codes (expires_at);

-- Access and refresh tokens. Stored hashed, exactly like Publisher Tokens.
create table if not exists oauth_tokens (
    token_hash text primary key,
    kind text not null check (kind in ('access', 'refresh')),
    client_id text not null,
    publisher_email text not null,
    scope text,
    resource text,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists oauth_tokens_publisher_email_created_at_idx
on oauth_tokens (publisher_email, created_at desc);

create index if not exists oauth_tokens_expires_at_idx
on oauth_tokens (expires_at);
