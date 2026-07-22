# Cyber Exoskeleton — Docs

This folder is the written record behind the project: the specs an agent builds
from, the engineering doctrine that shaped them, and the original course
curriculum the project forked from.

The specs and engineering notes are written in **Chinese** — they are mirrored
from a private Obsidian vault that is the source of truth. Cross-references that
pointed to private, unpublished notes have been flattened to plain text, and
operational secrets (key-location inventories, a third party's name) have been
redacted. Everything here is safe to read publicly.

Why publish them? So the next person building on this fork can see *why* each
decision was made — and skip the pits I already fell into.

## `specs/` — authoritative build specs

Each spec has the same shape: goals / non-goals, functional requirements,
**INV** (non-negotiable invariants), and **AC** (acceptance criteria).

| Spec | What it covers |
|------|----------------|
| [SPEC-00](specs/SPEC-00-project-foundation.md) | Fail-closed Supabase project + access control (Data API / RLS switches) |
| [SPEC-01](specs/SPEC-01-capture-channels.md) | Discord slash-command + iOS Siri capture — no unauthenticated public endpoints |
| [SPEC-02](specs/SPEC-02-mcp-server.md) | The read-only MCP server that exposes the brain to any LLM |
| [SPEC-03](specs/SPEC-03-agents-llm-gateway.md) | `call-llm` gateway, enrichment, weekly digest, `pg_cron` |
| [SPEC-04](specs/SPEC-04-eval-golden-set.md) | Golden Set + Recall@10 / MRR harness — build the ruler before upgrading retrieval |
| [SPEC-05](specs/SPEC-05-chunking.md) | Deterministic chunker + atomic replace — index small, preserve big |
| [SPEC-06](specs/SPEC-06-embedding-pipeline.md) | `call-embedding` gateway + `embed-chunks` state machine — per-row model, rebuildable vectors |
| [SPEC-07](specs/SPEC-07-hybrid-search.md) | Vector + keyword legs fused by RRF, thought-level ranking, degrade-with-a-flag |
| [SPEC-08](specs/SPEC-08-error-receipts-idempotency.md) | Discord error receipts + content-hash dedup (the source of the D-1…D-9 doctrine) |

## `engineering/` — doctrine and hard-won lessons

| Doc | What it is |
|-----|------------|
| [edge-cases-and-fixes.md](engineering/edge-cases-and-fixes.md) | The P0/P1/P2 risk & fix ledger — every known security/architecture debt item and how it was resolved |
| [design-pressure-test.md](engineering/design-pressure-test.md) | The D-1…D-9 checklist run before every spec: concurrency, crash, network, idempotency, attacker, scope, silent-failure, dependency, contract |
| [rag-operations-doctrine.md](engineering/rag-operations-doctrine.md) | RAG is a living system — retrieval quality drifts with the corpus; which upgrades (rerank, ANN, `pg_trgm`, HyDE) to wake and when |
| [agent-era-design-constraints.md](engineering/agent-era-design-constraints.md) | Design constraints for future agent workflows: the brain is read-only, irreversible actions are never auto-executed, retrieval never triggers a tool |

## `curriculum/` — course origin

The original Level 0–5 material this project forked from
(`King-Tuerto/open-brain-student`), kept read-only as the "where it came from"
record. When a spec and the curriculum disagree, the spec wins.

---

For agents working in this repo: start from the root `CLAUDE.md` and
`docs/STATUS.md`, then read the spec that routes to your task.
