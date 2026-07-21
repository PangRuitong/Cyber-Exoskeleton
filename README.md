# Cyber Exoskeleton

A personal AI knowledge base: capture everything you learn, store it in a database you own, and let any LLM read and search it by meaning. No vendor can take it away, change its price, or shut it down.

## Origin

This started as a graduate-course starter kit — a guided, five-level build ("Build Your Own AI Brain") for a personal, LLM-agnostic knowledge system on Supabase. The course gets you a working skeleton in a weekend.

This repo is that skeleton rebuilt as a real engineering project: fail-closed security from the first migration, a full retrieval-quality arc (chunking → embeddings → hybrid search) validated against an evaluation harness instead of vibes, and a spec-driven development process with its own design doctrine.

## What it does

Capture a thought — a quote, an idea, a link, a voice note — from Discord or Siri, and it lands in your own Postgres database. An LLM enriches it (summary, tags, category), it gets chunked and embedded, and it becomes searchable by meaning through an MCP server that any LLM client (Claude Code, Claude Desktop) can query. Weekly automation surfaces what you've been collecting.

The whole thing is LLM-agnostic and self-owned: the data lives in a database you control, and any model that speaks MCP can read it.

## Architecture

Five layers, `capture → storage → enrichment → consumption → automation`:

1. **Capture** — A Discord slash command and an iOS Siri Shortcut hit a `quick-capture` edge function. Inserts are idempotent (a date-scoped content hash computed by a database trigger, so no write path can bypass it), and capture failures return a real receipt: the raw HTTP error first as a fallback, then a plain-language explanation.
2. **Storage** — Supabase Postgres. A `thoughts` table (the source of truth) plus a `chunks` table for retrieval. Row-level security is fail-closed by design.
3. **Enrichment** — Every LLM call goes through a single gateway (`call-llm`) with a daily budget gate. Enrichment carries a status column and a daily backfill cron, so nothing silently stays un-enriched.
4. **Consumption** — An MCP server exposes `search_thoughts`, `list_recent`, and `add_thought`. Retrieval is hybrid (see below). Retrieved content is always wrapped in explicit data boundaries.
5. **Automation** — `pg_cron` jobs run the enrichment/embedding backfills and a weekly digest.

## Retrieval

The headline of the project. Search started as an `ilike` full-table scan — no semantics, and "promote a product" couldn't find a note about "marketing." It was rebuilt into hybrid retrieval:

- **Dual leg**: vector similarity (pgvector, `text-embedding-3-small`) + keyword search (`tsvector` + GIN).
- **Fusion**: Reciprocal Rank Fusion (RRF), with thought-level truncation before chunk expansion, filter pushdown, and a rerank hook left in place for when the corpus grows.
- **Validated**: every retrieval change closes against a golden-set eval harness. The switch moved recall@10 from **0.33 → 0.95** and MRR to **0.96**, with P95 latency under 1.5s — and semantic queries that previously returned *nothing* now return the right result.

Retrieval is treated as a living system, not a shipped feature: it gets re-evaluated as the corpus grows, with documented triggers for the next levers (reranking, ANN indexing, re-chunking, model migration).

## Security

- **Fail-closed RLS from creation** — the project was created with Data API on, auto-expose off, and auto-RLS on, so an unprotected table can't be born.
- **Three-bearer trust model** — separate, rotatable credentials for the capture channel, the automation agents, and the MCP client.
- **Read-only brain** — the MCP server exposes no destructive tools. Retrieved content enters model context as archived data behind boundary markers, never as instructions, as defense against indirect prompt injection.
- **Posture audit** — the deployment was audited against Supabase's security advisors and hardened to close every finding.

## Tech stack

TypeScript / Deno edge functions · Supabase (Postgres, pgvector, pg_cron) · Model Context Protocol · OpenAI (`gpt-5.4-mini` for enrichment, `text-embedding-3-small` for embeddings). LLM-agnostic by design — the API key is swappable and the retrieval interface is model-neutral.

## How it's built

Development is spec-driven. Each feature is a numbered SPEC with explicit acceptance criteria; work ships against those criteria and closes with evidence (migrations verified, eval deltas recorded, negative paths tested). Two doctrine documents govern the process — a design stress-test checklist run before every spec, and a retrieval-operations doctrine — kept in a separate engineering notebook alongside the handoffs and audits.

## Status

Core system complete (SPEC-00 through SPEC-08; the full RAG arc closed). Ongoing work is operational: keeping retrieval quality honest as the corpus grows, and backups/uptime for a self-owned database.
