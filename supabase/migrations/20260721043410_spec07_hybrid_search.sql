alter table public.chunks
  add column if not exists tsv tsvector
  generated always as (to_tsvector('simple', content)) stored;

create index if not exists chunks_tsv_gin_idx
  on public.chunks using gin (tsv);

create or replace function public.hybrid_search(
  p_query text,
  p_embedding extensions.vector,
  p_filters jsonb,
  p_candidate_k integer default 50,
  p_result_k integer default 10
)
returns table (
  chunk_id uuid,
  thought_id uuid,
  chunk_index integer,
  content text,
  source text,
  created_at timestamptz,
  fused_score double precision,
  vector_rank integer,
  keyword_rank integer,
  thought_rank integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_tsquery tsquery;
begin
  if p_query is null or length(btrim(p_query)) = 0 then
    raise exception 'p_query must be non-empty' using errcode = '22023';
  end if;
  if p_candidate_k is null or p_candidate_k < 1 then
    raise exception 'p_candidate_k must be positive' using errcode = '22023';
  end if;
  if p_result_k is null or p_result_k < 1 or p_result_k > 10 then
    raise exception 'p_result_k must be between 1 and 10' using errcode = '22023';
  end if;
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'p_filters must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(v_filters) as filter_key
    where filter_key not in ('sources', 'categories', 'created_after', 'created_before')
  ) then
    raise exception 'p_filters contains an unknown key' using errcode = '22023';
  end if;
  if v_filters ? 'sources' and (
    jsonb_typeof(v_filters -> 'sources') <> 'array'
    or exists (
      select 1 from jsonb_array_elements(v_filters -> 'sources') as value
      where jsonb_typeof(value) <> 'string'
    )
  ) then
    raise exception 'sources must be an array of strings' using errcode = '22023';
  end if;
  if v_filters ? 'categories' and (
    jsonb_typeof(v_filters -> 'categories') <> 'array'
    or exists (
      select 1 from jsonb_array_elements(v_filters -> 'categories') as value
      where jsonb_typeof(value) <> 'string'
    )
  ) then
    raise exception 'categories must be an array of strings' using errcode = '22023';
  end if;
  if v_filters ? 'created_after' and jsonb_typeof(v_filters -> 'created_after') <> 'string' then
    raise exception 'created_after must be an ISO8601 string' using errcode = '22023';
  end if;
  if v_filters ? 'created_before' and jsonb_typeof(v_filters -> 'created_before') <> 'string' then
    raise exception 'created_before must be an ISO8601 string' using errcode = '22023';
  end if;

  v_tsquery := plainto_tsquery('simple', p_query);

  return query
  with vector_candidates as (
    select
      c.id as chunk_id,
      c.thought_id,
      c.chunk_index,
      c.content,
      t.source,
      t.created_at,
      row_number() over (
        order by c.embedding operator(extensions.<=>) p_embedding asc, c.id asc
      )::integer as vector_rank
    from public.chunks as c
    join public.thoughts as t on t.id = c.thought_id
    where p_embedding is not null
      and c.embedding_status = 'done'
      and c.embedding is not null
      and (
        not (v_filters ? 'sources')
        or t.source in (select jsonb_array_elements_text(v_filters -> 'sources'))
      )
      and (
        not (v_filters ? 'categories')
        or t.category in (select jsonb_array_elements_text(v_filters -> 'categories'))
      )
      and (
        not (v_filters ? 'created_after')
        or t.created_at >= (v_filters ->> 'created_after')::timestamptz
      )
      and (
        not (v_filters ? 'created_before')
        or t.created_at <= (v_filters ->> 'created_before')::timestamptz
      )
    order by c.embedding operator(extensions.<=>) p_embedding asc, c.id asc
    limit p_candidate_k
  ),
  keyword_candidates as (
    select
      c.id as chunk_id,
      c.thought_id,
      c.chunk_index,
      c.content,
      t.source,
      t.created_at,
      row_number() over (
        order by ts_rank(c.tsv, v_tsquery) desc, c.id asc
      )::integer as keyword_rank
    from public.chunks as c
    join public.thoughts as t on t.id = c.thought_id
    where c.tsv @@ v_tsquery
      and (
        not (v_filters ? 'sources')
        or t.source in (select jsonb_array_elements_text(v_filters -> 'sources'))
      )
      and (
        not (v_filters ? 'categories')
        or t.category in (select jsonb_array_elements_text(v_filters -> 'categories'))
      )
      and (
        not (v_filters ? 'created_after')
        or t.created_at >= (v_filters ->> 'created_after')::timestamptz
      )
      and (
        not (v_filters ? 'created_before')
        or t.created_at <= (v_filters ->> 'created_before')::timestamptz
      )
    order by ts_rank(c.tsv, v_tsquery) desc, c.id asc
    limit p_candidate_k
  ),
  fused_candidates as (
    select
      coalesce(v.chunk_id, k.chunk_id) as chunk_id,
      coalesce(v.thought_id, k.thought_id) as thought_id,
      coalesce(v.chunk_index, k.chunk_index) as chunk_index,
      coalesce(v.content, k.content) as content,
      coalesce(v.source, k.source) as source,
      coalesce(v.created_at, k.created_at) as created_at,
      (
        case when v.vector_rank is null then 0 else 1.0 / (60 + v.vector_rank) end
        + case when k.keyword_rank is null then 0 else 1.0 / (60 + k.keyword_rank) end
      )::double precision as fused_score,
      v.vector_rank,
      k.keyword_rank
    from vector_candidates as v
    full outer join keyword_candidates as k using (chunk_id)
  ),
  rerank_hook as (
    -- rerankHook(query, candidates) -> candidates. Identity in v1.
    -- Future query/chunk cross-encoder scoring belongs exactly here: after RRF,
    -- before thought_score aggregation. The surrounding CTE contract stays fixed.
    select * from fused_candidates
  ),
  thought_scores as (
    select rh.thought_id, max(rh.fused_score) as thought_score
    from rerank_hook as rh
    group by rh.thought_id
  ),
  ranked_thoughts as (
    select
      scores.thought_id,
      row_number() over (
        order by scores.thought_score desc, scores.thought_id asc
      )::integer as thought_rank
    from thought_scores as scores
  ),
  selected_thoughts as (
    select ranked.thought_id, ranked.thought_rank
    from ranked_thoughts as ranked
    where ranked.thought_rank <= p_result_k
  ),
  expanded as (
    select
      r.chunk_id,
      r.thought_id,
      r.chunk_index,
      r.content,
      r.source,
      r.created_at,
      r.fused_score,
      r.vector_rank,
      r.keyword_rank,
      s.thought_rank,
      row_number() over (
        partition by r.thought_id
        order by r.fused_score desc, r.chunk_index asc, r.chunk_id asc
      ) as chunk_within_thought
    from rerank_hook as r
    join selected_thoughts as s on s.thought_id = r.thought_id
  )
  select
    e.chunk_id,
    e.thought_id,
    e.chunk_index,
    e.content,
    e.source,
    e.created_at,
    e.fused_score,
    e.vector_rank,
    e.keyword_rank,
    e.thought_rank
  from expanded as e
  where e.chunk_within_thought <= 2
  order by e.thought_rank asc, e.fused_score desc, e.chunk_index asc, e.chunk_id asc;
end;
$$;

alter function public.hybrid_search(text, extensions.vector, jsonb, integer, integer) owner to postgres;
revoke all on function public.hybrid_search(text, extensions.vector, jsonb, integer, integer) from public;
revoke all on function public.hybrid_search(text, extensions.vector, jsonb, integer, integer) from anon;
revoke all on function public.hybrid_search(text, extensions.vector, jsonb, integer, integer) from authenticated;
grant execute on function public.hybrid_search(text, extensions.vector, jsonb, integer, integer) to service_role;
