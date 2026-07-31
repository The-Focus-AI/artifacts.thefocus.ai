-- Publisher Tokens gain a kind and a revocation timestamp so a token pasted
-- into a third-party MCP client config can be killed without logging the
-- Publisher out of the CLI.
-- See docs/adr/0007-remote-mcp-endpoint-over-publisher-tokens.md.

alter table publisher_tokens
    add column if not exists kind text not null default 'cli';

alter table publisher_tokens
    add column if not exists label text;

alter table publisher_tokens
    add column if not exists revoked_at timestamptz;

create index if not exists publisher_tokens_publisher_email_revoked_at_idx
on publisher_tokens (publisher_email, revoked_at);
