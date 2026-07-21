-- Replace this public project identifier before running in the SQL editor.
with config as (
  select 'https://YOUR_PROJECT_REF.supabase.co'::text as project_url
)
select net.http_post(
  url := (select project_url from config) || '/functions/v1/chunk-thought',
  headers := jsonb_build_object(
    'Content-Type',
    'application/json',
    'Authorization',
    'Bearer ' || (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'AGENT_ACCESS_KEY'
      limit 1
    )
  ),
  body := $json${"mode":"backfill"}$json$::jsonb,
  timeout_milliseconds := 5000
) as request_id;
