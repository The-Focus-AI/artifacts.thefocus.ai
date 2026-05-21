create table if not exists publisher_tokens (
    token_hash text primary key,
    publisher_email text not null,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
);

create index if not exists publisher_tokens_publisher_email_created_at_idx
on publisher_tokens (publisher_email, created_at desc);
