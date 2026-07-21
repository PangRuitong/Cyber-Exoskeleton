create or replace function public.enqueue_embedding_backfill()
returns bigint language plpgsql security definer set search_path = '' as $$
declare agent_access_key text; request_id bigint;
begin
  select decrypted_secret into agent_access_key from vault.decrypted_secrets where name = 'AGENT_ACCESS_KEY' limit 1;
  if agent_access_key is null or length(agent_access_key) = 0 then raise exception 'AGENT_ACCESS_KEY is not configured in Vault'; end if;
  select net.http_post(
    url := 'https://paymgkqxjafutozxcsnh.supabase.co/functions/v1/embed-chunks',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || agent_access_key),
    body := jsonb_build_object('mode','backfill'), timeout_milliseconds := 5000) into request_id;
  return request_id;
end;
$$;
alter function public.enqueue_embedding_backfill() owner to postgres;
revoke all on function public.enqueue_embedding_backfill() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'embed-backfill-daily';
select cron.schedule('embed-backfill-daily', '15 9 * * *', $$select public.enqueue_embedding_backfill();$$);
