import { createClient } from "jsr:@supabase/supabase-js@2";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const MODEL = () =>
  Deno.env.get("EMBEDDING_MODEL")?.trim() || "text-embedding-3-small";
type Chunk = { id: string; thought_id: string; content: string };
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
function bearer(req: Request) {
  return (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)
    ?.[1] ?? "";
}
function client() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return url && key ? createClient(url, key) : null;
}

async function callEmbedding(texts: string[]) {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("AGENT_ACCESS_KEY") ?? "";
  const response = await fetch(
    `${url.replace(/\/$/, "")}/functions/v1/call-embedding`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ texts }),
    },
  );
  if (!response.ok) {
    return {
      error: `call-embedding HTTP ${response.status}`,
      status: response.status,
    };
  }
  const body = await response.json() as {
    model?: unknown;
    embeddings?: unknown;
  };
  if (typeof body.model !== "string" || !Array.isArray(body.embeddings)) {
    return { error: "invalid embedding response", status: 502 };
  }
  return {
    model: body.model,
    embeddings: body.embeddings as number[][],
    status: 200,
  };
}

async function embedDocument(
  db: NonNullable<ReturnType<typeof client>>,
  thoughtId: string,
  statuses: string[],
) {
  const { data: candidates, error } = await db.from("chunks").select(
    "id,thought_id,content",
  ).eq("thought_id", thoughtId).in("embedding_status", statuses);
  if (error || !candidates?.length) {
    return { embedded: 0, failed: 0, skipped: 1, stop: false };
  }
  const chunks = candidates as Chunk[];
  const ids = chunks.map((chunk) => chunk.id);
  const { data: claimed, error: claimError } = await db.from("chunks").update({
    embedding_status: "retrying",
    embedding_error: null,
  }).in("id", ids).in("embedding_status", statuses).select(
    "id,thought_id,content",
  );
  if (claimError || !claimed?.length) {
    return { embedded: 0, failed: 0, skipped: 1, stop: false };
  }
  const locked = claimed as Chunk[];
  let embedded = 0;
  for (let start = 0; start < locked.length; start += 100) {
    const batch = locked.slice(start, start + 100);
    const result = await callEmbedding(batch.map((chunk) => chunk.content));
    if ("error" in result) {
      const remaining = locked.slice(start).map((chunk) => chunk.id);
      await db.from("chunks").update({
        embedding_status: "failed",
        embedding_error: result.error,
      }).in("id", remaining);
      return {
        embedded,
        failed: remaining.length,
        skipped: 0,
        stop: result.status === 429,
      };
    }
    const rows = batch.map((chunk, index) => ({
      id: chunk.id,
      embedding: result.embeddings[index],
      embedding_model: result.model,
      embedded_at: new Date().toISOString(),
      embedding_status: "done",
      embedding_error: null,
    }));
    for (const row of rows) {
      const { error: updateError } = await db.from("chunks").update(row).eq(
        "id",
        row.id,
      ).eq("embedding_status", "retrying");
      if (updateError) {
        await db.from("chunks").update({
          embedding_status: "failed",
          embedding_error: "embedding write failed",
        }).eq("id", row.id);
        return { embedded, failed: 1, skipped: 0, stop: false };
      }
      embedded += 1;
    }
  }
  return { embedded, failed: 0, skipped: 0, stop: false };
}

Deno.serve(async (req) => {
  const key = Deno.env.get("AGENT_ACCESS_KEY") ?? "";
  if (!key || bearer(req) !== key) return json(401, { error: "unauthorized" });
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  let body: { mode?: unknown; thought_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const db = client();
  if (!db) return json(500, { error: "database configuration missing" });
  const documentMode = body.mode === "document" &&
    typeof body.thought_id === "string";
  if (body.mode !== "backfill" && !documentMode) {
    return json(400, { error: "invalid request" });
  }
  const docs = new Set<string>();
  if (documentMode) docs.add(body.thought_id as string);
  else {
    const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const model = MODEL();
    const [pending, retrying, stale] = await Promise.all([
      db.from("chunks").select("thought_id").in("embedding_status", [
        "pending",
        "failed",
      ]).limit(1000),
      db.from("chunks").select("thought_id").eq("embedding_status", "retrying")
        .lt("updated_at", staleBefore).limit(1000),
      db.from("chunks").select("thought_id").eq("embedding_status", "done").neq(
        "embedding_model",
        model,
      ).limit(1000),
    ]);
    for (const result of [pending, retrying, stale]) {
      for (const row of result.data ?? []) {
        docs.add(row.thought_id);
      }
    }
  }
  let embedded = 0, failed = 0, skipped = 0;
  for (const thoughtId of docs) {
    const statuses = documentMode
      ? ["pending"]
      : ["pending", "failed", "retrying", "done"];
    const result = await embedDocument(db, thoughtId, statuses);
    embedded += result.embedded;
    failed += result.failed;
    skipped += result.skipped;
    if (result.stop) break;
  }
  return json(200, { embedded, failed, skipped });
});
