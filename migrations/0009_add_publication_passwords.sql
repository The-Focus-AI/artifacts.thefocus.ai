-- Publication passwords. See docs/adr/0010-publication-passwords.md.
-- password_hash null = no password. unlock_ttl_ms null = an unlock lasts
-- until the password changes.
alter table publications
add column if not exists password_hash text,
add column if not exists unlock_ttl_ms bigint;

-- One row per wrong password, keyed by Publication and client address.
-- The gate counts the rows of the last minute and deletes older ones.
create table if not exists publication_unlock_failures (
  limit_key text not null,
  failed_at timestamptz not null
);

create index if not exists publication_unlock_failures_key_idx
on publication_unlock_failures (limit_key, failed_at);
