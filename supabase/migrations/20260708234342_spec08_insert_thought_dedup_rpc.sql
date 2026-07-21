create or replace function public.insert_thought_dedup(
  p_content text,
  p_source text
)
returns table (id uuid, inserted boolean)
language sql
set search_path = ''
as $$
  insert into public.thoughts (content, source)
  values (p_content, p_source)
  on conflict (content_hash) do update
    set content_hash = excluded.content_hash
  returning public.thoughts.id, (xmax = 0) as inserted;
$$;

revoke all on function public.insert_thought_dedup(text, text) from public;
revoke all on function public.insert_thought_dedup(text, text) from anon;
revoke all on function public.insert_thought_dedup(text, text) from authenticated;
grant execute on function public.insert_thought_dedup(text, text) to service_role;
