-- Replace this public project identifier before running in the SQL editor.
with config as (
  select 'https://YOUR_PROJECT_REF.supabase.co'::text as project_url
)
select net.http_post(
  url := (select project_url from config) || '/functions/v1/open-brain-mcp',
  headers := jsonb_build_object(
    'Content-Type',
    'application/json',
    'Authorization',
    'Bearer ' || (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'MCP_ACCESS_KEY'
      limit 1
    )
  ),
  body := $json${"jsonrpc":"2.0","id":505,"method":"tools/call","params":{"name":"search_thoughts","arguments":{"query":"皇权"}}}$json$::jsonb,
  timeout_milliseconds := 5000
) as request_id;
