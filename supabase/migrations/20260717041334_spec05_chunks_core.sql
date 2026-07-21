create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  thought_id uuid not null references public.thoughts(id),
  chunk_index integer not null,
  content text not null,
  content_hash text generated always as (encode(sha256(content::bytea), 'hex')) stored,
  chunker text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (thought_id, chunk_index)
);

create trigger set_chunks_updated_at
before update on public.chunks
for each row
execute function public.set_updated_at();

alter table public.chunks enable row level security;

revoke all on table public.chunks from public;
revoke all on table public.chunks from anon;
revoke all on table public.chunks from authenticated;

grant select, insert, update, delete on table public.chunks to service_role;

alter table public.thoughts
  add column chunking_status text not null default 'pending',
  add column chunked_at timestamptz;

create or replace function public.replace_chunks(
  p_thought_id uuid,
  p_chunks jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.chunks
  where thought_id = p_thought_id;

  insert into public.chunks (thought_id, chunk_index, content, chunker)
  select
    p_thought_id,
    chunk_index,
    content,
    chunker
  from pg_catalog.jsonb_to_recordset(p_chunks) as chunks(
    chunk_index integer,
    content text,
    chunker text
  );

  update public.thoughts
  set chunking_status = 'done',
      chunked_at = now()
  where id = p_thought_id;
end;
$$;

alter function public.replace_chunks(uuid, jsonb) owner to postgres;

revoke all on function public.replace_chunks(uuid, jsonb) from public;
revoke all on function public.replace_chunks(uuid, jsonb) from anon;
revoke all on function public.replace_chunks(uuid, jsonb) from authenticated;
grant execute on function public.replace_chunks(uuid, jsonb) to service_role;

create or replace function public.enqueue_thought_chunking_webhook()
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
    raise warning 'AGENT_ACCESS_KEY is not configured in Vault; skipping chunk-thought webhook';
    return new;
  end if;

  perform net.http_post(
    url := 'https://paymgkqxjafutozxcsnh.supabase.co/functions/v1/chunk-thought',
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

alter function public.enqueue_thought_chunking_webhook() owner to postgres;

revoke all on function public.enqueue_thought_chunking_webhook() from public;
revoke all on function public.enqueue_thought_chunking_webhook() from anon;
revoke all on function public.enqueue_thought_chunking_webhook() from authenticated;

create trigger chunk_thought_after_insert
after insert on public.thoughts
for each row
execute function public.enqueue_thought_chunking_webhook();
