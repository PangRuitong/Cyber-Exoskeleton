create or replace function public.enqueue_thought_enrichment_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  agent_access_key text;
begin
  select decrypted_secret
    into agent_access_key
  from vault.decrypted_secrets
  where name = 'AGENT_ACCESS_KEY'
  limit 1;

  if agent_access_key is null or length(agent_access_key) = 0 then
    raise warning 'AGENT_ACCESS_KEY is not configured in Vault';
    return new;
  end if;

  perform net.http_post(
    url := 'https://paymgkqxjafutozxcsnh.supabase.co/functions/v1/enrich-thought',
    headers := jsonb_build_object(
      'Content-Type',
      'application/json',
      'Authorization',
      'Bearer ' || agent_access_key
    ),
    body := jsonb_build_object('record', to_jsonb(new)),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

alter function public.enqueue_thought_enrichment_webhook() owner to postgres;

revoke all on function public.enqueue_thought_enrichment_webhook() from public;
revoke all on function public.enqueue_thought_enrichment_webhook() from anon;
revoke all on function public.enqueue_thought_enrichment_webhook() from authenticated;
