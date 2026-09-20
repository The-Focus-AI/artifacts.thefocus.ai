alter table publications
add column if not exists pwa boolean not null default false;
