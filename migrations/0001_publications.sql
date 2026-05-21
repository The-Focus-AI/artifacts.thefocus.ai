create table if not exists publications (
    opaque_id text primary key,
    publication_url_path text not null unique,
    publisher_email text not null,
    status text not null check (status in ('active', 'removed')),
    active_manifest_ref text not null,
    local_source_path text,
    revision_window_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    removed_at timestamptz
);

create index if not exists publications_publisher_email_updated_at_idx
on publications (publisher_email, updated_at desc);

create index if not exists publications_status_idx
on publications (status);
