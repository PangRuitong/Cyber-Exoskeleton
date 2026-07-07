import { createClient } from "jsr:@supabase/supabase-js@2";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const unauthorizedBody = JSON.stringify({ error: "unauthorized" });
const knownSources = ["siri", "discord", "mcp", "web"] as const;
const digestCategories = [
  "idea",
  "learning",
  "question",
  "reference",
  "plan",
  "reflection",
  "uncategorized",
];

type ThoughtRow = {
  id: string;
  content: string;
  created_at: string;
  source: string | null;
  category: string | null;
  summary: string | null;
};

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

function getDigestMinRows() {
  const raw = Deno.env.get("DIGEST_MIN_ROWS")?.trim();
  if (!raw) {
    return 5;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 5;
  }

  return Math.floor(parsed);
}

function sourceCounts(rows: ThoughtRow[]) {
  const counts = new Map<string, number>();
  for (const source of knownSources) {
    counts.set(source, 0);
  }

  for (const row of rows) {
    const source = row.source ?? "unknown";
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  return counts;
}

function formatSourceCounts(counts: Map<string, number>) {
  const orderedSources = [
    ...knownSources,
    ...[...counts.keys()].filter((source) => !knownSources.includes(source as typeof knownSources[number])).sort(),
  ];

  return [
    "Source counts (last 7 days):",
    ...orderedSources.map((source) => `${source}: ${counts.get(source) ?? 0}`),
  ].join("\n");
}

function fallbackSummary(row: ThoughtRow) {
  return (row.summary && row.summary.trim().length > 0)
    ? row.summary.trim()
    : row.content.slice(0, 200).trim();
}

function formatRowsByCategory(rows: ThoughtRow[]) {
  const grouped = new Map<string, ThoughtRow[]>();
  for (const category of digestCategories) {
    grouped.set(category, []);
  }

  for (const row of rows) {
    const category = row.category ?? "uncategorized";
    if (!grouped.has(category)) {
      grouped.set(category, []);
    }
    grouped.get(category)?.push(row);
  }

  return [...grouped.entries()]
    .filter(([, categoryRows]) => categoryRows.length > 0)
    .map(([category, categoryRows]) => {
      const items = categoryRows.map((row) => {
        const source = row.source ?? "unknown";
        return `- [${source}] ${fallbackSummary(row)}`;
      });

      return [`## ${category}`, ...items].join("\n");
    })
    .join("\n\n");
}

function buildDigestPrompt(rows: ThoughtRow[]) {
  return [
    "Write a concise weekly digest from archived thought summaries.",
    "Group the main themes by category. Include one section titled \"正在探索的问题\" with one or more open questions inferred from the week.",
    "Do not invent source counts. Do not include markdown code fences.",
    "",
    "Categorized inputs:",
    formatRowsByCategory(rows),
  ].join("\n");
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
        "You write compact weekly digests from archived personal notes. Return only the digest body requested.",
      maxTokens: 1200,
    }),
  });

  const bodyText = await response.text();
  let reason = bodyText.trim();
  let text = "";

  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; text?: unknown };
    if (typeof parsed.error === "string") {
      reason = parsed.error;
    }
    if (typeof parsed.text === "string") {
      text = parsed.text;
    }
  } catch {
    // Keep text fallback for errors.
  }

  if (!response.ok) {
    throw new Error(reason || `call-llm ${response.status}`);
  }

  if (!text.trim()) {
    throw new Error("call-llm returned empty text");
  }

  return text.trim();
}

async function handleDigest() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return json(500, { created: false, reason: "database configuration missing" });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("thoughts")
    .select("id,content,created_at,source,category,summary")
    .gte("created_at", since)
    .neq("source", "digest")
    .or("category.is.null,category.neq.digest")
    .order("created_at", { ascending: true });

  if (error) {
    return json(500, { created: false, reason: "database query failed" });
  }

  const rows = (data ?? []) as ThoughtRow[];
  const minRows = getDigestMinRows();
  if (rows.length < minRows) {
    console.log(`weekly-digest skipped: insufficient content (${rows.length} < ${minRows})`);
    return json(200, {
      created: false,
      reason: `insufficient content (${rows.length} < ${minRows})`,
    });
  }

  const sourceTable = formatSourceCounts(sourceCounts(rows));
  let llmText: string;
  try {
    llmText = await callLlm(buildDigestPrompt(rows));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "call-llm failed";
    return json(200, { created: false, reason });
  }

  const content = `${sourceTable}\n\n${llmText}`;
  const { data: inserted, error: insertError } = await supabase
    .from("thoughts")
    .insert({
      content,
      source: "digest",
      category: "digest",
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    return json(500, { created: false, reason: "digest insert failed" });
  }

  return json(200, { created: true, thought_id: inserted.id });
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

  return await handleDigest();
}

Deno.serve(handleRequest);
