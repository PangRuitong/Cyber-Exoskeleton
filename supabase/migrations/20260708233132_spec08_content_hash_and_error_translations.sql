create or replace function public.compute_thought_content_hash(
  thought_content text,
  thought_created_at timestamptz
)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.replace(
          pg_catalog.replace(
            pg_catalog.btrim(coalesce(thought_content, '')),
            E'\r\n',
            E'\n'
          ),
          E'\r',
          E'\n'
        ) || '|' ||
        pg_catalog.to_char(
          thought_created_at at time zone 'UTC',
          'YYYY-MM-DD'
        ),
        'UTF8'
      )
    ),
    'hex'
  );
$$;

revoke all on function public.compute_thought_content_hash(text, timestamptz) from public;
revoke all on function public.compute_thought_content_hash(text, timestamptz) from anon;
revoke all on function public.compute_thought_content_hash(text, timestamptz) from authenticated;

drop trigger if exists set_thoughts_content_hash_before_insert on public.thoughts;
drop trigger if exists set_thought_content_hash_before_insert on public.thoughts;

do $$
begin
  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'thoughts'
      and a.attname = 'content_hash'
      and a.attnum > 0
      and not a.attisdropped
      and a.attgenerated <> ''
  ) then
    alter table public.thoughts drop column content_hash;
  end if;
end $$;

alter table public.thoughts
  add column if not exists content_hash text;

update public.thoughts
set content_hash = public.compute_thought_content_hash(content, created_at)
where content_hash is distinct from public.compute_thought_content_hash(content, created_at);

create or replace function public.set_thought_content_hash()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at = coalesce(new.created_at, now());
  new.content_hash = public.compute_thought_content_hash(new.content, new.created_at);
  return new;
end;
$$;

revoke all on function public.set_thought_content_hash() from public;
revoke all on function public.set_thought_content_hash() from anon;
revoke all on function public.set_thought_content_hash() from authenticated;

create trigger set_thought_content_hash_before_insert
before insert on public.thoughts
for each row
execute function public.set_thought_content_hash();

create unique index if not exists thoughts_content_hash_key
  on public.thoughts (content_hash);

create table if not exists public.error_translations (
  error_hash text primary key,
  translation text not null,
  created_at timestamptz not null default now()
);

alter table public.error_translations enable row level security;

revoke all on table public.error_translations from public;
revoke all on table public.error_translations from anon;
revoke all on table public.error_translations from authenticated;

grant select, insert, update on table public.error_translations to service_role;
