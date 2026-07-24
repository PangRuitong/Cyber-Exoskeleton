import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const defaultHybridCandidateK = 50;

export type HybridSearchRow = {
  chunk_id: string;
  thought_id: string;
  chunk_index: number;
  content: string;
  source: string | null;
  created_at: string;
  fused_score: number;
  vector_rank: number | null;
  keyword_rank: number | null;
  thought_rank: number;
};

type ChunkCountRow = { thought_id: string };

export type HybridSearchOutcome =
  | {
    ok: true;
    rows: HybridSearchRow[];
    chunkCounts: Map<string, number>;
    degraded: boolean;
    degradedReason: string | null;
  }
  | { ok: false; status: number; reason: string; cause?: unknown };

type QueryEmbeddingResult =
  | { embedding: number[]; degraded: false }
  | { embedding: null; degraded: true; reason: string };

async function getQueryEmbedding(query: string): Promise<QueryEmbeddingResult> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "") ?? "";
  const agentAccessKey = Deno.env.get("AGENT_ACCESS_KEY") ?? "";
  if (!supabaseUrl || !agentAccessKey) {
    return {
      embedding: null,
      degraded: true,
      reason: "embedding gateway configuration unavailable",
    };
  }

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/call-embedding`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentAccessKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ texts: [query] }),
      signal: AbortSignal.timeout(4500),
    });
    if (!response.ok) {
      return {
        embedding: null,
        degraded: true,
        reason: `embedding gateway HTTP ${response.status}`,
      };
    }
    const body = await response.json() as { embeddings?: unknown };
    const embedding = Array.isArray(body.embeddings) ? body.embeddings[0] : null;
    if (
      !Array.isArray(embedding) || embedding.length !== 1536 ||
      embedding.some((value) => typeof value !== "number")
    ) {
      return {
        embedding: null,
        degraded: true,
        reason: "embedding gateway returned an invalid vector",
      };
    }
    return { embedding, degraded: false };
  } catch {
    return {
      embedding: null,
      degraded: true,
      reason: "embedding gateway request failed",
    };
  }
}

export function getHybridCandidateK() {
  const value = Number(Deno.env.get("HYBRID_CANDIDATE_K") ?? defaultHybridCandidateK);
  return Number.isInteger(value) && value > 0 ? value : defaultHybridCandidateK;
}

function logHybridSearch(queryLength: number, rows: HybridSearchRow[], degraded: boolean) {
  const vectorTop5 = rows
    .filter((row) => row.vector_rank !== null)
    .sort((left, right) =>
      (left.vector_rank ?? Number.MAX_SAFE_INTEGER) - (right.vector_rank ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, 5)
    .map((row) => ({ chunk_id: row.chunk_id, rank: row.vector_rank }));
  const keywordTop5 = rows
    .filter((row) => row.keyword_rank !== null)
    .sort((left, right) =>
      (left.keyword_rank ?? Number.MAX_SAFE_INTEGER) - (right.keyword_rank ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, 5)
    .map((row) => ({ chunk_id: row.chunk_id, rank: row.keyword_rank }));
  console.log(JSON.stringify({
    event: "hybrid_search",
    query_length: queryLength,
    vector_top5: vectorTop5,
    keyword_top5: keywordTop5,
    fused_top: rows.map((row) => ({ chunk_id: row.chunk_id, thought_rank: row.thought_rank })),
    degraded,
  }));
}

export async function runHybridSearch(
  supabase: SupabaseClient,
  query: string,
  filters: unknown,
  resultK: number,
): Promise<HybridSearchOutcome> {
  const embeddingResult = await getQueryEmbedding(query);
  if (embeddingResult.degraded) {
    console.warn(JSON.stringify({
      event: "hybrid_search_degraded",
      query_length: query.length,
      reason: embeddingResult.reason,
    }));
  }

  const { data, error } = await supabase.rpc("hybrid_search", {
    p_query: query,
    p_embedding: embeddingResult.embedding,
    p_filters: filters,
    p_candidate_k: getHybridCandidateK(),
    p_result_k: resultK,
  });

  if (error) {
    console.error(JSON.stringify({
      event: "hybrid_search_rpc_failed",
      query_length: query.length,
    }));
    return { ok: false, status: 500, reason: "hybrid_search_rpc_failed", cause: error };
  }

  const rows = (data ?? []) as HybridSearchRow[];
  logHybridSearch(query.length, rows, embeddingResult.degraded);

  const thoughtIds = [...new Set(rows.map((row) => row.thought_id))];
  const { data: countData, error: countError } = thoughtIds.length === 0
    ? { data: [] as ChunkCountRow[], error: null }
    : await supabase.from("chunks").select("thought_id").in("thought_id", thoughtIds);
  if (countError) {
    return { ok: false, status: 500, reason: "chunk_count_failed", cause: countError };
  }

  const chunkCounts = new Map<string, number>();
  for (const row of countData ?? []) {
    chunkCounts.set(row.thought_id, (chunkCounts.get(row.thought_id) ?? 0) + 1);
  }

  return {
    ok: true,
    rows,
    chunkCounts,
    degraded: embeddingResult.degraded,
    degradedReason: embeddingResult.degraded ? embeddingResult.reason : null,
  };
}
