-- Publication passwords. See docs/adr/0010-publication-passwords.md.
-- password_hash null = no password. unlock_ttl_ms null = an unlock lasts
-- until the password changes.
alter table publications
add column if not exists password_hash text,
add column if not exists unlock_ttl_ms bigint;

-- One row per submitted password, keyed by Publication and client address.
-- The gate counts the rows of the last minute and deletes older ones.
create table if not exists publication_unlock_attempts (
  limit_key text not null,
  attempted_at timestamptz not null
);

create index if not exists publication_unlock_attempts_key_idx
on publication_unlock_attempts (limit_key, attempted_at);

create index if not exists publication_unlock_attempts_attempted_at_idx
on publication_unlock_attempts (attempted_at);
