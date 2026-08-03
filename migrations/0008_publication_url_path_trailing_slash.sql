-- Publication root paths are canonically `/a/{opaque_id}/`. The trailing slash
-- is what makes a relative link in the Entry Page resolve under the Publication
-- instead of the site root. Rows written before that rule stored `/a/{opaque_id}`;
-- backfill them so stored and returned paths agree. Reads normalize either
-- shape, so this migration is safe to run before or after the deploy.
update publications
set publication_url_path = publication_url_path || '/'
where publication_url_path not like '%/';
