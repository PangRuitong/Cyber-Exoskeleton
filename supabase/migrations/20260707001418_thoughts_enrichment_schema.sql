alter table public.thoughts
  add column tags text[],
  add column category text,
  add column summary text,
  add column enriched_at timestamptz,
  add column error_message text,
  add column enrichment_status text not null default 'pending',
  add column content_hash text generated always as (encode(sha256(content::bytea), 'hex')) stored,
  add column updated_at timestamptz not null default now();

create index thoughts_content_hash_idx
  on public.thoughts (content_hash);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public;
revoke all on function public.set_updated_at() from anon;
revoke all on function public.set_updated_at() from authenticated;

create trigger set_thoughts_updated_at
before update on public.thoughts
for each row
execute function public.set_updated_at();

create table public.llm_daily_usage (
  day date primary key,
  count integer not null default 0
);

alter table public.llm_daily_usage enable row level security;

revoke all on table public.llm_daily_usage from public;
revoke all on table public.llm_daily_usage from anon;
revoke all on table public.llm_daily_usage from authenticated;

grant select, insert, update on table public.llm_daily_usage to service_role;
