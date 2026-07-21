# Retrieval evaluation

The real golden set and run archives are derived from a private thought corpus and
are intentionally ignored by Git. Copy `eval/golden_set.example.json` to
`eval/golden_set.json`, replace every example query and UUID with fixtures from
your own corpus, and expand it to at least 30 entries before running an eval.

Run `deno run --allow-net --allow-env --allow-read=eval --allow-write=eval/runs --allow-run=git eval/run_eval.ts --label baseline` with `SUPABASE_URL` and `MCP_ACCESS_KEY` set in the environment. Add `--stratum A`, `B`, or `C` to run a subset. The runner writes an immutable local archive only after every selected query succeeds. Never commit a real golden set or raw run archive unless its contents have been deliberately anonymized.
