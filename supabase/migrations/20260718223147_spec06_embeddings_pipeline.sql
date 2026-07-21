create extension if not exists vector;

alter table public.chunks
  add column embedding extensions.vector(1536),
  add column embedding_model text,
  add column embedding_status text not null default 'pending',
  add column embedded_at timestamptz,
  add column embedding_error text;

alter table public.llm_daily_usage
  add column kind text not null default 'llm';

alter table public.llm_daily_usage
  drop constraint llm_daily_usage_pkey,
  add primary key (day, kind);
