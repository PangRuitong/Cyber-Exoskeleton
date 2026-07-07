create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

create or replace function public.enqueue_weekly_digest()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  agent_access_key text;
  request_id bigint;
begin
  select decrypted_secret
    into agent_access_key
  from vault.decrypted_secrets
  where name = 'AGENT_ACCESS_KEY'
  limit 1;

  if agent_access_key is null or length(agent_access_key) = 0 then
    raise exception 'AGENT_ACCESS_KEY is not configured in Vault';
  end if;

  select net.http_post(
    url := 'https://paymgkqxjafutozxcsnh.supabase.co/functions/v1/weekly-digest',
    headers := jsonb_build_object(
      'Content-Type',
      'application/json',
      'Authorization',
      'Bearer ' || agent_access_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  )
    into request_id;

  return request_id;
end;
$$;

alter function public.enqueue_weekly_digest() owner to postgres;

revoke all on function public.enqueue_weekly_digest() from public;
revoke all on function public.enqueue_weekly_digest() from anon;
revoke all on function public.enqueue_weekly_digest() from authenticated;

select cron.unschedule(jobid)
from cron.job
where jobname = 'weekly-digest-sunday';

select cron.schedule(
  'weekly-digest-sunday',
  '0 15 * * 0',
  $$select public.enqueue_weekly_digest();$$
);
