alter table publications
add column if not exists active_artifact_locator text;

update publications
set active_artifact_locator = active_manifest_ref
where active_artifact_locator is null;

alter table publications
alter column active_artifact_locator set not null;
