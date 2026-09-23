-- Platform Web Push subscriptions for installable PWA Publications.
-- See docs/adr/0010-platform-owns-pwa-web-push.md.
--
-- Apply to the Artifacts Neon database before treating subscribe as live.
-- HTTP 410 Gone cleanup of stale endpoints happens in the send path, not here.

create table if not exists pwa_push_subscriptions (
    id text primary key,
    opaque_id text not null references publications (opaque_id),
    endpoint text not null unique,
    p256dh text not null,
    auth text not null,
    user_agent text,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create index if not exists pwa_push_subscriptions_opaque_id_idx
on pwa_push_subscriptions (opaque_id);
