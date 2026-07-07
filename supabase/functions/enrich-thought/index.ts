import { createClient } from "jsr:@supabase/supabase-js@2";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const unauthorizedBody = JSON.stringify({ error: "unauthorized" });
const categories = [
  "idea",
  "learning",
  "question",
  "reference",
  "plan",
  "reflection",
  "digest",
] as const;
const categorySet = new Set<string>(categories);
const categoryList = "idea / learning / question / reference / plan / reflection / digest";
const maxPromptContentChars = 4000;

type ThoughtRecord = {
  id?: unknown;
  content?: unknown;
  source?: unknown;
  category?: unknown;
  enrichment_status?: unknown;
  content_hash?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type EnrichmentResult = {
  tags: string[];
  category: string;
  summary: string;
};

type ProcessStatus = "done" | "failed" | "skipped" | "ignored" | "deduplicated" | "budget";

class BudgetExceededError extends Error {
  constructor() {
    super("budget exceeded, deferred to next backfill");
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function unauthorized() {
  return new Response(unauthorizedBody, {
    status: 401,
    headers: jsonHeaders,
  });
}

function getBearerToken(req: Request) {
  const authorization = req.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

function getSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function messageFromError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "unknown error";
}

function trimErrorMessage(message: string) {
  return message.replace(/\s+/g, " ").slice(0, 1000);
}

async function markFailed(id: string, message: string, supabase = getSupabaseClient()) {
  if (!supabase) {
    return;
  }

  await supabase.from("thoughts").update({
    tags: null,
    category: null,
    summary: null,
    enrichment_status: "failed",
    error_message: trimErrorMessage(message),
  }).eq("id", id);
}

function buildPrompt(content: string) {
  const clippedContent = content.slice(0, maxPromptContentChars);

  return [
    "Return strict JSON only. Do not use markdown fences. Do not include extra text.",
    `The category must be exactly one of: ${categoryList}.`,
    'Return this shape: { "tags": ["short tag", "short tag", "short tag"], "category": "idea", "summary": "one sentence summary" }.',
    "Use 3-5 short tags. The summary must be one sentence.",
    "",
    "Thought content:",
    clippedContent,
  ].join("\n");
}

function stripJsonFence(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function validateEnrichment(rawText: string): EnrichmentResult {
  const parsed = JSON.parse(stripJsonFence(rawText)) as {
    tags?: unknown;
    category?: unknown;
    summary?: unknown;
  };

  if (!Array.isArray(parsed.tags)) {
    throw new Error("tags validation failed: expected array");
  }

  if (parsed.tags.some((tag) => typeof tag !== "string" || tag.trim().length === 0)) {
    throw new Error("tags validation failed: expected non-empty strings");
  }

  const tags = parsed.tags.map((tag) => (tag as string).trim());
  if (tags.length < 3) {
    throw new Error("tags validation failed: expected at least 3 tags");
  }

  if (typeof parsed.category !== "string" || !categorySet.has(parsed.category)) {
    throw new Error(`category validation failed: expected one of ${categoryList}`);
  }

  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
    throw new Error("summary validation failed: expected non-empty string");
  }

  return {
    tags: tags.slice(0, 5),
    category: parsed.category,
    summary: parsed.summary.trim(),
  };
}

async function callLlm(prompt: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "") ?? "";
  const agentAccessKey = Deno.env.get("AGENT_ACCESS_KEY") ?? "";

  if (!supabaseUrl || !agentAccessKey) {
    throw new Error("call-llm configuration missing");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${agentAccessKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      systemPrompt:
        "You classify archived thoughts for retrieval. Return only valid JSON matching the requested schema.",
      maxTokens: 500,
    }),
  });

  const bodyText = await response.text();
  let errorText = bodyText.trim();
  let text = "";

  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; text?: unknown };
    if (typeof parsed.error === "string") {
      errorText = parsed.error;
    }
    if (typeof parsed.text === "string") {
      text = parsed.text;
    }
  } catch {
    // Keep text fallback for errors and empty text for successful malformed responses.
  }

  if (response.status === 429) {
    throw new BudgetExceededError();
  }

  if (!response.ok) {
    throw new Error(`call-llm ${response.status}: ${errorText || "request failed"}`);
  }

  return text;
}

async function processThought(
  record: ThoughtRecord,
  options: { requirePending: boolean; alreadyClaimed: boolean },
): Promise<ProcessStatus> {
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) {
    return "failed";
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return "failed";
  }

  try {
    if (record.source === "digest" || record.category === "digest") {
      await supabase.from("thoughts").update({
        enrichment_status: "skipped",
        error_message: null,
      }).eq("id", id);

      return "skipped";
    }

    if (options.requirePending && record.enrichment_status !== "pending") {
      return "ignored";
    }

    if (typeof record.content_hash === "string" && record.content_hash.trim().length > 0) {
      const { data: duplicate, error: duplicateError } = await supabase
        .from("thoughts")
        .select("id,tags,category,summary")
        .eq("content_hash", record.content_hash)
        .eq("enrichment_status", "done")
        .neq("id", id)
        .limit(1)
        .maybeSingle();

      if (duplicateError) {
        throw new Error(`duplicate lookup failed: ${duplicateError.message}`);
      }

      if (duplicate) {
        const { error: updateError } = await supabase.from("thoughts").update({
          tags: duplicate.tags,
          category: duplicate.category,
          summary: duplicate.summary,
          enriched_at: new Date().toISOString(),
          enrichment_status: "done",
          error_message: null,
        }).eq("id", id);

        if (updateError) {
          throw new Error(`duplicate copy failed: ${updateError.message}`);
        }

        return "deduplicated";
      }
    }

    if (!options.alreadyClaimed) {
      const { error: retryingError } = await supabase.from("thoughts").update({
        enrichment_status: "retrying",
        error_message: null,
      }).eq("id", id);

      if (retryingError) {
        throw new Error(`status update failed: ${retryingError.message}`);
      }
    }

    if (typeof record.content !== "string" || record.content.trim().length === 0) {
      throw new Error("content validation failed: expected non-empty string");
    }

    const llmText = await callLlm(buildPrompt(record.content));
    const enrichment = validateEnrichment(llmText);
    const { error: doneError } = await supabase.from("thoughts").update({
      tags: enrichment.tags,
      category: enrichment.category,
      summary: enrichment.summary,
      enriched_at: new Date().toISOString(),
      enrichment_status: "done",
      error_message: null,
    }).eq("id", id);

    if (doneError) {
      throw new Error(`final update failed: ${doneError.message}`);
    }

    return "done";
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      await markFailed(id, error.message, supabase);
      return "budget";
    }

    await markFailed(id, messageFromError(error), supabase);
    return "failed";
  }
}

async function handleWebhook(record: ThoughtRecord) {
  const status = await processThought(record, {
    requirePending: true,
    alreadyClaimed: false,
  });

  if (status === "failed" || status === "budget") {
    return json(200, { ok: false });
  }

  return json(200, { ok: true, status });
}

async function fetchBackfillCandidates() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("database configuration missing");
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const candidateFilter = [
    "enrichment_status.eq.failed",
    `and(enrichment_status.eq.pending,created_at.lt.${oneHourAgo})`,
    `and(enrichment_status.eq.retrying,updated_at.lt.${oneHourAgo})`,
  ].join(",");

  const { data, error } = await supabase
    .from("thoughts")
    .select("id,content,source,category,enrichment_status,content_hash,created_at,updated_at")
    .or(candidateFilter)
    .neq("source", "digest")
    .or("category.is.null,category.neq.digest")
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    throw new Error(`candidate query failed: ${error.message}`);
  }

  return (data ?? []) as ThoughtRecord[];
}

async function claimBackfillCandidate(record: ThoughtRecord) {
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) {
    return false;
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("database configuration missing");
  }

  const { data, error } = await supabase
    .from("thoughts")
    .update({ enrichment_status: "retrying", error_message: null })
    .eq("id", id)
    .in("enrichment_status", ["failed", "pending", "retrying"])
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`claim failed: ${error.message}`);
  }

  return !!data;
}

async function handleBackfill() {
  const candidates = await fetchBackfillCandidates();
  let retried = 0;
  let succeeded = 0;
  let failed = 0;
  let stoppedByBudget = false;

  for (const candidate of candidates) {
    const claimed = await claimBackfillCandidate(candidate);
    if (!claimed) {
      continue;
    }

    retried += 1;
    const status = await processThought(candidate, {
      requirePending: false,
      alreadyClaimed: true,
    });

    if (status === "done" || status === "deduplicated") {
      succeeded += 1;
    } else if (status === "budget") {
      failed += 1;
      stoppedByBudget = true;
      break;
    } else if (status === "failed") {
      failed += 1;
    }
  }

  return json(200, {
    retried,
    succeeded,
    failed,
    stopped_by_budget: stoppedByBudget,
  });
}

async function handleRequest(req: Request) {
  const agentAccessKey = Deno.env.get("AGENT_ACCESS_KEY") ?? "";
  const providedToken = getBearerToken(req);

  if (!agentAccessKey || providedToken !== agentAccessKey) {
    return unauthorized();
  }

  if (req.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid request" });
  }

  if (isObject(body) && isObject(body.record)) {
    return await handleWebhook(body.record);
  }

  if (isObject(body) && body.mode === "backfill") {
    return await handleBackfill();
  }

  return json(400, { error: "invalid request" });
}

Deno.serve(handleRequest);
