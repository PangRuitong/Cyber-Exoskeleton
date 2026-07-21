import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const unauthorizedBody = JSON.stringify({ error: "unauthorized" });
const defaultMaxTokens = 1000;
const defaultDailyBudget = 200;

type RequestBody = {
  prompt?: unknown;
  systemPrompt?: unknown;
  maxTokens?: unknown;
  effort?: unknown;
};

type ReasoningEffort = "none" | "low" | "medium" | "high";

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

function getDailyBudget() {
  const rawBudget = Deno.env.get("LLM_DAILY_BUDGET")?.trim();
  if (!rawBudget) {
    return defaultDailyBudget;
  }

  const budget = Number(rawBudget);
  if (!Number.isFinite(budget) || budget < 0) {
    return defaultDailyBudget;
  }

  return Math.floor(budget);
}

function normalizeMaxTokens(value: unknown) {
  if (value === undefined) {
    return defaultMaxTokens;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return null;
  }

  return Math.floor(value);
}

function normalizeEffort(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  ) {
    return value;
  }

  return null;
}

function summarizeUpstreamError(value: string) {
  let message = value.trim();

  try {
    const parsed = JSON.parse(value) as {
      error?: { message?: unknown; type?: unknown };
      message?: unknown;
    };

    if (typeof parsed.error?.message === "string") {
      message = parsed.error.message;
    } else if (typeof parsed.message === "string") {
      message = parsed.message;
    } else if (typeof parsed.error?.type === "string") {
      message = parsed.error.type;
    }
  } catch {
    // Keep the trimmed text fallback below.
  }

  if (!message) {
    return "upstream request failed";
  }

  return message.replace(/\s+/g, " ").slice(0, 240);
}

async function incrementDailyUsage() {
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL")?.trim() ??
    Deno.env.get("DATABASE_URL")?.trim() ??
    "";

  if (!databaseUrl) {
    throw new Error("database url not configured");
  }

  const client = new Client(databaseUrl);
  await client.connect();

  try {
    const result = await client.queryObject<{ count: number }>`
      insert into public.llm_daily_usage (day, kind, count)
      values (current_date, 'llm', 1)
      on conflict (day, kind) do update
        set count = public.llm_daily_usage.count + 1
      returning count
    `;

    const count = result.rows[0]?.count;
    if (typeof count !== "number") {
      throw new Error("usage counter did not return a count");
    }

    return count;
  } finally {
    await client.end();
  }
}

async function callAnthropic(
  prompt: string,
  systemPrompt: string | undefined,
  maxTokens: number,
) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim() ?? "";
  if (!apiKey) {
    return json(502, { error: "provider key not configured" });
  }

  const model = Deno.env.get("LLM_MODEL")?.trim() ?? "";
  if (!model) {
    return json(502, { error: "model not configured" });
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };

  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  if (!response.ok) {
    return json(502, { error: summarizeUpstreamError(responseText) });
  }

  const parsed = JSON.parse(responseText) as {
    content?: Array<{ type?: string; text?: unknown }>;
  };
  const text = (parsed.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");

  return json(200, { text });
}

async function callOpenAi(
  prompt: string,
  systemPrompt: string | undefined,
  maxTokens: number,
  effort: ReasoningEffort | undefined,
) {
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
  if (!apiKey) {
    return json(502, { error: "provider key not configured" });
  }

  const model = Deno.env.get("LLM_MODEL")?.trim() ?? "";
  if (!model) {
    return json(502, { error: "model not configured" });
  }

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = {
    model,
    max_completion_tokens: maxTokens,
    messages,
  };

  const reasoningEffort = effort ?? Deno.env.get("LLM_REASONING_EFFORT")?.trim();
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  if (!response.ok) {
    return json(502, { error: summarizeUpstreamError(responseText) });
  }

  const parsed = JSON.parse(responseText) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const text = parsed.choices?.[0]?.message?.content;

  return json(200, { text: typeof text === "string" ? text : "" });
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

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid request" });
  }

  const prompt = body.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return json(400, { error: "invalid request" });
  }

  const systemPrompt = typeof body.systemPrompt === "string"
    ? body.systemPrompt
    : undefined;
  const maxTokens = normalizeMaxTokens(body.maxTokens);
  if (maxTokens === null) {
    return json(400, { error: "invalid request" });
  }
  const effort = normalizeEffort(body.effort);
  if (effort === null) {
    return json(400, { error: "invalid request" });
  }

  let count: number;
  try {
    count = await incrementDailyUsage();
  } catch {
    return json(500, { error: "budget check failed" });
  }

  if (count > getDailyBudget()) {
    return json(429, { error: "daily budget exceeded", count });
  }

  const provider = Deno.env.get("LLM_PROVIDER")?.trim().toLowerCase() ?? "";
  try {
    if (provider === "anthropic") {
      // Anthropic does not consume the OpenAI reasoning effort option.
      return await callAnthropic(prompt, systemPrompt, maxTokens);
    }

    if (provider === "openai") {
      return await callOpenAi(prompt, systemPrompt, maxTokens, effort);
    }

    return json(502, { error: "unknown provider" });
  } catch {
    return json(502, { error: "upstream request failed" });
  }
}

Deno.serve(handleRequest);
