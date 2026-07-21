import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DAILY_BUDGET = 500;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
function bearer(req: Request) {
  return (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)
    ?.[1] ?? "";
}
function safeError(value: string) {
  try {
    const body = JSON.parse(value);
    const message = body?.error?.message ?? body?.message;
    if (typeof message === "string") {
      return message.replace(/\s+/g, " ").slice(0, 240);
    }
  } catch { /* use constant */ }
  return "upstream request failed";
}
function budgetLimit() {
  const value = Number(
    Deno.env.get("EMBEDDING_DAILY_BUDGET") ?? DEFAULT_DAILY_BUDGET,
  );
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_DAILY_BUDGET;
}
async function incrementBudget() {
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL")?.trim() ??
    Deno.env.get("DATABASE_URL")?.trim() ?? "";
  if (!databaseUrl) throw new Error("database url not configured");
  const client = new Client(databaseUrl);
  await client.connect();
  try {
    const result = await client.queryObject<{ count: number }>`
      insert into public.llm_daily_usage (day, kind, count)
      values (current_date, 'embedding', 1)
      on conflict (day, kind) do update set count = public.llm_daily_usage.count + 1
      returning count`;
    return result.rows[0]?.count;
  } finally {
    await client.end();
  }
}

Deno.serve(async (req) => {
  const accessKey = Deno.env.get("AGENT_ACCESS_KEY") ?? "";
  if (!accessKey || bearer(req) !== accessKey) {
    return json(401, { error: "unauthorized" });
  }
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  let body: { texts?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const texts = body.texts;
  if (
    !Array.isArray(texts) || texts.length < 1 || texts.length > 100 ||
    texts.some((text) => typeof text !== "string" || text.length > 6000)
  ) {
    return json(400, { error: "invalid request" });
  }
  let count: number | undefined;
  try {
    count = await incrementBudget();
  } catch {
    return json(500, { error: "budget check failed" });
  }
  if (!count || count > budgetLimit()) {
    return json(429, { error: "daily budget exceeded", count });
  }
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
  if (!apiKey) return json(502, { error: "provider key not configured" });
  const model = Deno.env.get("EMBEDDING_MODEL")?.trim() || DEFAULT_MODEL;
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input: texts }),
    });
    const responseText = await response.text();
    if (!response.ok) return json(502, { error: safeError(responseText) });
    const parsed = JSON.parse(responseText) as {
      data?: Array<{ index?: number; embedding?: unknown }>;
    };
    const embeddings = (parsed.data ?? []).sort((a, b) =>
      (a.index ?? 0) - (b.index ?? 0)
    ).map((item) => item.embedding);
    if (
      embeddings.length !== texts.length ||
      embeddings.some((item) => !Array.isArray(item) || item.length !== 1536)
    ) return json(502, { error: "invalid embedding response" });
    return json(200, { model, embeddings });
  } catch {
    return json(502, { error: "upstream request failed" });
  }
});
