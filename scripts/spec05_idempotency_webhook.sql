-- Replace this public project identifier before running in the SQL editor.
with config as (
  select 'https://YOUR_PROJECT_REF.supabase.co'::text as project_url
), target as (
  select to_jsonb(t) as record
  from public.thoughts t
  where t.category is distinct from 'digest'
    and nullif(btrim(t.content), '') is not null
  order by t.created_at desc
  limit 1
)
select net.http_post(
  url := (select project_url from config) || '/functions/v1/chunk-thought',
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'AGENT_ACCESS_KEY' limit 1)),
  body := jsonb_build_object('record', (select record from target)),
  timeout_milliseconds := 5000
) as request_id
union all
select net.http_post(
  url := (select project_url from config) || '/functions/v1/chunk-thought',
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'AGENT_ACCESS_KEY' limit 1)),
  body := jsonb_build_object('record', (select record from target)),
  timeout_milliseconds := 5000
);
