type Stratum = "A" | "B" | "C";
type Language = "zh" | "en";

type GoldenEntry = {
  id: string;
  query: string;
  expected_thought_ids: string[];
  stratum: Stratum;
  lang: Language;
  notes?: string;
  added: string;
};

type GoldenSet = {
  meta: Record<string, unknown>;
  entries: GoldenEntry[];
};

type ReturnedAnchor = { anchor_id: string };

type EntryResult = {
  id: string;
  query: string;
  stratum: Stratum;
  lang: Language;
  expected_thought_ids: string[];
  returned_ids: string[];
  hits: string[];
  latency_ms: number;
  reciprocal_rank: number;
};

type MetricSummary = {
  query_count: number;
  expected_id_count: number;
  hit_count: number;
  recall_at_10: number;
  mrr: number;
};

const RETRIEVAL_IMPL = "hybrid-rrf";
const MAX_RESULTS = 10;
const UUID_RE = /\bid=([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b/gi;
const DEGRADED_MARKER = "[degraded:";
const RUN_TIME_ZONE = "America/Phoenix";

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(args: string[]) {
  let stratum: Stratum | undefined;
  let label = "baseline";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stratum") {
      const value = args[++index];
      if (value !== "A" && value !== "B" && value !== "C") {
        fail("--stratum must be A, B, or C");
      }
      stratum = value;
    } else if (arg === "--label") {
      label = args[++index] ?? "";
      if (!/^[A-Za-z0-9_-]+$/.test(label)) {
        fail(
          "--label may contain only letters, digits, underscores, and hyphens",
        );
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "deno run --allow-net --allow-env --allow-write=eval/runs --allow-run=git eval/run_eval.ts [--stratum A|B|C] [--label LABEL]",
      );
      Deno.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return { stratum, label };
}

function validateGoldenSet(value: unknown): GoldenSet {
  if (
    !value || typeof value !== "object" ||
    !Array.isArray((value as GoldenSet).entries)
  ) {
    fail("eval/golden_set.json is invalid");
  }
  const entries = (value as GoldenSet).entries;
  if (entries.length < 30) fail("golden set must contain at least 30 entries");
  for (const entry of entries) {
    if (
      !entry.id || !entry.query || !Array.isArray(entry.expected_thought_ids) ||
      entry.expected_thought_ids.length === 0
    ) {
      fail("golden set contains an incomplete entry");
    }
    if (
      entry.stratum !== "A" && entry.stratum !== "B" && entry.stratum !== "C"
    ) fail(`invalid stratum: ${entry.id}`);
    if (entry.lang !== "zh" && entry.lang !== "en") {
      fail(`invalid language: ${entry.id}`);
    }
  }
  return value as GoldenSet;
}

function textFromToolResult(value: unknown): string {
  const result = (value as { result?: unknown }).result;
  const content = result && typeof result === "object"
    ? (result as { content?: unknown }).content
    : undefined;
  if (!Array.isArray(content)) {
    fail("MCP response did not contain tool content");
  }
  const text = content
    .filter((item): item is { type: "text"; text: string } =>
      !!item && typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    )
    .map((item) => item.text)
    .join("\n");
  if (!text) fail("MCP response contained no text");
  return text;
}

// Keep this conversion as the future chunk-to-parent seam: callers compare anchor_id,
// not a display string or a particular row format.
function parseReturnedAnchors(text: string): ReturnedAnchor[] {
  const ids: string[] = [];
  for (const match of text.matchAll(UUID_RE)) {
    const id = match[1].toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_RESULTS).map((anchor_id) => ({ anchor_id }));
}

async function callSearchThoughts(
  endpoint: string,
  accessKey: string,
  query: string,
  id: number,
): Promise<{ anchors: ReturnedAnchor[]; degraded: boolean }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "search_thoughts", arguments: { query } },
    }),
  });
  if (!response.ok) {
    fail(`MCP request failed for ${query}: HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    fail(`MCP request returned invalid JSON for ${query}`);
  }
  const error = body && typeof body === "object"
    ? (body as { error?: unknown }).error
    : undefined;
  if (error) {
    fail(
      `MCP returned a JSON-RPC error for ${query}: ${JSON.stringify(error)}`,
    );
  }
  const text = textFromToolResult(body);
  return {
    anchors: parseReturnedAnchors(text),
    degraded: text.includes(DEGRADED_MARKER),
  };
}

function summarize(results: EntryResult[]): MetricSummary {
  const expectedIdCount = results.reduce(
    (total, result) => total + result.expected_thought_ids.length,
    0,
  );
  const hitCount = results.reduce(
    (total, result) => total + result.hits.length,
    0,
  );
  return {
    query_count: results.length,
    expected_id_count: expectedIdCount,
    hit_count: hitCount,
    recall_at_10: expectedIdCount === 0 ? 0 : hitCount / expectedIdCount,
    mrr: results.length === 0
      ? 0
      : results.reduce((total, result) => total + result.reciprocal_rank, 0) /
        results.length,
  };
}

async function gitCommit(): Promise<string | null> {
  try {
    const command = new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      stdout: "piped",
      stderr: "null",
    });
    const output = await command.output();
    return output.success
      ? new TextDecoder().decode(output.stdout).trim()
      : null;
  } catch {
    return null;
  }
}

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

async function main() {
  const { stratum, label } = parseArgs(Deno.args);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const accessKey = Deno.env.get("MCP_ACCESS_KEY");
  if (!supabaseUrl || !accessKey) {
    fail("SUPABASE_URL and MCP_ACCESS_KEY must both be set");
  }

  const goldenSet = validateGoldenSet(
    JSON.parse(await Deno.readTextFile("eval/golden_set.json")),
  );
  const entries = stratum
    ? goldenSet.entries.filter((entry) => entry.stratum === stratum)
    : goldenSet.entries;
  if (entries.length === 0) fail("no golden-set entries selected");
  const endpoint = `${
    supabaseUrl.replace(/\/$/, "")
  }/functions/v1/open-brain-mcp`;
  const results: EntryResult[] = [];

  for (const [index, entry] of entries.entries()) {
    const startedAt = performance.now();
    const search = await callSearchThoughts(
      endpoint,
      accessKey,
      entry.query,
      index + 1,
    );
    if (search.degraded) {
      fail(
        `invalid eval run: degraded retrieval observed at ${entry.id}; archive not written`,
      );
    }
    const latency_ms = Math.round(performance.now() - startedAt);
    // parseReturnedAnchors deduplicates repeated chunks from the same thought in
    // first-seen order, so recall@10 and MRR use thought_rank rather than rows.
    const returned_ids = search.anchors.map((anchor) => anchor.anchor_id);
    const hits = entry.expected_thought_ids.filter((expected) =>
      returned_ids.includes(expected)
    );
    const firstHitIndex = returned_ids.findIndex((returned) =>
      entry.expected_thought_ids.includes(returned)
    );
    results.push({
      id: entry.id,
      query: entry.query,
      stratum: entry.stratum,
      lang: entry.lang,
      expected_thought_ids: entry.expected_thought_ids,
      returned_ids,
      hits,
      latency_ms,
      reciprocal_rank: firstHitIndex === -1 ? 0 : 1 / (firstHitIndex + 1),
    });
  }

  const archive = {
    timestamp: new Date().toISOString(),
    git_commit: await gitCommit(),
    retrieval_impl: RETRIEVAL_IMPL,
    baseline: false,
    valid: true,
    metric_unit: "distinct_thought_rank",
    comparison: {
      baseline_files: [
        "2026-07-16-baseline-1.json",
        "2026-07-16-baseline-2.json",
      ],
      baseline_retrieval_impl: "ilike-baseline",
      corpus_drift_caveat:
        "The baseline corpus had fewer thoughts. All golden target thoughts remain present; added thoughts only increase top-10 competition, so B>0 is a conservative pass. Investigate corpus drift if A falls below 0.95.",
    },
    selection: { stratum: stratum ?? "all", label },
    entries: results,
    summary: {
      overall: summarize(results),
      by_stratum: Object.fromEntries(
        (["A", "B", "C"] as Stratum[]).map((
          value,
        ) => [
          value,
          summarize(results.filter((result) => result.stratum === value)),
        ]),
      ),
      by_language: Object.fromEntries(
        (["zh", "en"] as Language[]).map((
          value,
        ) => [
          value,
          summarize(results.filter((result) => result.lang === value)),
        ]),
      ),
    },
  };
  const date = dateInTimeZone(new Date(archive.timestamp), RUN_TIME_ZONE);
  const outputPath = `eval/runs/${date}-${label}.json`;
  try {
    await Deno.stat(outputPath);
    fail(`refusing to overwrite immutable archive: ${outputPath}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir("eval/runs", { recursive: true });
  const temporaryPath = `eval/runs/.${date}-${label}.tmp`;
  await Deno.writeTextFile(
    temporaryPath,
    `${JSON.stringify(archive, null, 2)}\n`,
  );
  await Deno.rename(temporaryPath, outputPath);
  console.log(`${outputPath}\n${JSON.stringify(archive.summary.overall)}`);
}

main().catch((error) => {
  console.error(
    `eval failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  Deno.exit(1);
});
