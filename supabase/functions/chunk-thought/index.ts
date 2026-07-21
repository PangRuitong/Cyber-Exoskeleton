import { createClient } from "jsr:@supabase/supabase-js@2";
import { chunkDocument } from "./chunkers.ts";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

type ThoughtRecord = {
  id?: unknown;
  content?: unknown;
  chunking_status?: unknown;
};

type ProcessStatus = "done" | "failed" | "ignored";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function getBearerToken(req: Request) {
  const match = (req.headers.get("authorization") ?? "").match(
    /^Bearer\s+(.+)$/i,
  );
  return match?.[1] ?? "";
}

function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return url && serviceRoleKey ? createClient(url, serviceRoleKey) : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function markFailed(
  id: string,
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
) {
  await supabase.from("thoughts").update({ chunking_status: "failed" }).eq(
    "id",
    id,
  );
}

async function processThought(record: ThoughtRecord): Promise<ProcessStatus> {
  const id = typeof record.id === "string" ? record.id : "";
  const supabase = getSupabaseClient();
  if (!id || !supabase) return "failed";

  try {
    if (typeof record.content !== "string") {
      throw new Error("content validation failed: expected string");
    }

    const chunks = chunkDocument({ content: record.content });
    const { error } = await supabase.rpc("replace_chunks", {
      p_thought_id: id,
      p_chunks: chunks,
    });
    if (error) throw new Error(`replace_chunks failed: ${error.message}`);
    return "done";
  } catch (error) {
    console.error(`chunk-thought failed for ${id}: ${messageFromError(error)}`);
    await markFailed(id, supabase);
    return "failed";
  }
}

async function fetchBackfillCandidates() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("database configuration missing");
  const { data, error } = await supabase
    .from("thoughts")
    .select("id,content,chunking_status")
    .in("chunking_status", ["pending", "failed"])
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`candidate query failed: ${error.message}`);
  return (data ?? []) as ThoughtRecord[];
}

async function handleBackfill() {
  const candidates = await fetchBackfillCandidates();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  for (const candidate of candidates) {
    processed += 1;
    const status = await processThought(candidate);
    if (status === "done") succeeded += 1;
    if (status === "failed") failed += 1;
  }
  return json(200, { processed, succeeded, failed });
}

async function handleRequest(req: Request) {
  const agentAccessKey = Deno.env.get("AGENT_ACCESS_KEY") ?? "";
  if (!agentAccessKey || getBearerToken(req) !== agentAccessKey) {
    return json(401, { error: "unauthorized" });
  }
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid request" });
  }

  if (isObject(body) && body.mode === "backfill") return await handleBackfill();
  if (isObject(body) && isObject(body.record)) {
    const status = await processThought(body.record);
    if (status === "done" && typeof body.record.id === "string") {
      const url = Deno.env.get("SUPABASE_URL") ?? "";
      const key = Deno.env.get("AGENT_ACCESS_KEY") ?? "";
      if (url && key) {
        void fetch(`${url.replace(/\/$/, "")}/functions/v1/embed-chunks`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "document",
            thought_id: body.record.id,
          }),
        }).catch((error) =>
          console.error(
            `embed-chunks tail call failed: ${messageFromError(error)}`,
          )
        );
      }
    }
    return json(200, { ok: status !== "failed", status });
  }
  return json(200, { ok: false, status: "failed" });
}

Deno.serve(handleRequest);
