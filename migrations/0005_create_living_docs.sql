-- Living Docs: collaborative Markdown documents an agent publishes for a
-- Reviewer to edit and comment on, and pulls feedback back from.
-- See docs/adr/0005-living-docs-agent-human-review-loop.md.

create table if not exists living_docs (
    opaque_id text primary key,
    review_id text not null unique,
    publisher_email text not null,
    status text not null check (status in ('active', 'removed')),
    title text,
    current_markdown text not null,
    latest_version_number integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    removed_at timestamptz
);

create index if not exists living_docs_publisher_email_updated_at_idx
on living_docs (publisher_email, updated_at desc);

create index if not exists living_docs_status_idx
on living_docs (status);

-- An immutable snapshot of a Living Doc's Markdown, cut each time the agent
-- pulls feedback. version_number is monotonic per Living Doc.
create table if not exists living_doc_versions (
    id text primary key,
    living_doc_id text not null references living_docs (opaque_id),
    version_number integer not null,
    markdown text not null,
    created_at timestamptz not null default now(),
    unique (living_doc_id, version_number)
);

create index if not exists living_doc_versions_doc_idx
on living_doc_versions (living_doc_id, version_number desc);

-- A Reviewer note (or an agent reply) anchored to a span of the Markdown.
create table if not exists living_doc_comments (
    id text primary key,
    living_doc_id text not null references living_docs (opaque_id),
    origin text not null check (origin in ('reviewer', 'agent')),
    author text,
    anchor_quote text not null,
    anchor_start integer,
    anchor_end integer,
    body text not null,
    parent_comment_id text references living_doc_comments (id),
    status text not null check (status in ('open', 'resolved')) default 'open',
    created_at timestamptz not null default now()
);

create index if not exists living_doc_comments_doc_idx
on living_doc_comments (living_doc_id, created_at);

-- An agent-proposed change to a span, which the Reviewer accepts or rejects.
create table if not exists living_doc_suggestions (
    id text primary key,
    living_doc_id text not null references living_docs (opaque_id),
    version_number integer not null,
    anchor_quote text not null,
    anchor_start integer,
    anchor_end integer,
    replacement text not null,
    note text,
    status text not null
        check (status in ('pending', 'accepted', 'rejected'))
        default 'pending',
    created_at timestamptz not null default now(),
    resolved_at timestamptz
);

create index if not exists living_doc_suggestions_doc_idx
on living_doc_suggestions (living_doc_id, created_at);
