import { createClient } from "jsr:@supabase/supabase-js@2";
import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import nacl from "npm:tweetnacl@1.0.3";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const encoder = new TextEncoder();
const maxDiscordContentChars = 1900;
const maxThoughtPreviewChars = 500;
const maxErrorSummaryChars = 280;
const insertTimeoutMs = 10000;
const discordApiBase = "https://discord.com/api/v10";
const allowedEfforts = new Set(["none", "low", "medium", "high"]);

type DiscordInteraction = {
  type?: unknown;
  application_id?: unknown;
  token?: unknown;
  data?: {
    name?: unknown;
    options?: DiscordOption[];
  };
};

type DiscordOption = {
  name?: unknown;
  value?: unknown;
};

type DiscordResponseTarget = {
  applicationId: string;
  token: string;
};

type ThoughtRow = {
  id: string;
  content: string;
  created_at: string;
  source: string | null;
};

type InsertThoughtResult = {
  id: string;
  inserted: boolean;
};

class CommandError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    readonly causeValue?: unknown,
  ) {
    super(errorType);
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function deferredResponse() {
  return json(200, { type: 5 });
}

function empty(status: number) {
  return new Response(null, { status });
}

function hexToBytes(value: string) {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return null;
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }

  return bytes;
}

function verifyDiscordSignature(req: Request, rawBody: string) {
  const publicKey = Deno.env.get("DISCORD_PUBLIC_KEY") ?? "";
  const signature = req.headers.get("x-signature-ed25519") ?? "";
  const timestamp = req.headers.get("x-signature-timestamp") ?? "";

  const publicKeyBytes = hexToBytes(publicKey);
  const signatureBytes = hexToBytes(signature);

  if (
    !publicKeyBytes ||
    publicKeyBytes.length !== 32 ||
    !signatureBytes ||
    signatureBytes.length !== 64 ||
    !timestamp
  ) {
    return false;
  }

  return nacl.sign.detached.verify(
    encoder.encode(`${timestamp}${rawBody}`),
    signatureBytes,
    publicKeyBytes,
  );
}

function parseInteraction(rawBody: string): DiscordInteraction | null {
  try {
    const body = JSON.parse(rawBody);
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function getResponseTarget(interaction: DiscordInteraction): DiscordResponseTarget | null {
  if (typeof interaction.application_id !== "string" || typeof interaction.token !== "string") {
    return null;
  }

  return {
    applicationId: interaction.application_id,
    token: interaction.token,
  };
}

function getSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

function getCommandName(interaction: DiscordInteraction) {
  const name = interaction.data?.name;
  return typeof name === "string" ? name : null;
}

function getStringOption(interaction: DiscordInteraction, name: string) {
  const option = interaction.data?.options?.find((item) => item.name === name);
  return typeof option?.value === "string" ? option.value : null;
}

function escapeLikePattern(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function limitDiscordMessage(content: string) {
  if (content.length <= maxDiscordContentChars) {
    return content;
  }

  return `${content.slice(0, maxDiscordContentChars)}\n...[reply truncated]`;
}

function limitErrorSummary(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= maxErrorSummaryChars
    ? normalized
    : `${normalized.slice(0, maxErrorSummaryChars)}...`;
}

function formatPreview(row: ThoughtRow) {
  if (row.content.length <= maxThoughtPreviewChars) {
    return row.content;
  }

  const remainingChars = row.content.length - maxThoughtPreviewChars;
  return `${row.content.slice(0, maxThoughtPreviewChars)}...[truncated ${remainingChars} chars, full content in thought id=${row.id}]`;
}

function formatThoughtRows(rows: ThoughtRow[]) {
  const lines: string[] = [];

  for (const [index, row] of rows.entries()) {
    const source = row.source ?? "unknown";
    const nextLine = [
      `${index + 1}. ${row.created_at} source=${source} id=${row.id}`,
      formatPreview(row),
    ].join("\n");

    const candidate = [...lines, nextLine].join("\n\n");
    if (candidate.length > maxDiscordContentChars) {
      lines.push(`...[results too long, showing first ${lines.length}]`);
      break;
    }

    lines.push(nextLine);
  }

  return lines.join("\n\n");
}

function toThoughtRow(value: unknown): ThoughtRow {
  return value as ThoughtRow;
}

function getErrorDedupWindowSeconds() {
  const raw = Deno.env.get("ERROR_DEDUP_WINDOW")?.trim();
  if (!raw) {
    return 3600;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 3600;
}

function getErrorTranslateEffort() {
  const effort = Deno.env.get("EFFORT_ERROR_TRANSLATE")?.trim() || "low";
  return allowedEfforts.has(effort) ? effort : "low";
}

function getErrorFields(error: unknown) {
  if (error instanceof CommandError) {
    return {
      status: error.status,
      type: error.errorType,
      raw: error.causeValue,
    };
  }

  return {
    status: 500,
    type: error instanceof Error && error.name ? error.name : "unknown_error",
    raw: error,
  };
}

function getStringField(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function extractConstraint(value: unknown) {
  const haystack = [
    getStringField(value, "message"),
    getStringField(value, "details"),
    getStringField(value, "hint"),
    value instanceof Error ? value.message : "",
  ].join(" ");
  const match = haystack.match(/constraint ["']?([A-Za-z0-9_]+)["']?/i);
  return match?.[1] ?? "";
}

function normalizeErrorForHash(error: unknown) {
  const fields = getErrorFields(error);
  const constraint = extractConstraint(fields.raw);
  return [
    `type=${fields.type}`,
    constraint ? `constraint=${constraint}` : "",
    `status=${fields.status}`,
  ].filter(Boolean).join(" ");
}

async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function patchOriginal(target: DiscordResponseTarget, content: string) {
  const response = await fetch(
    `${discordApiBase}/webhooks/${target.applicationId}/${target.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: limitDiscordMessage(content),
        allowed_mentions: { parse: [] },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`discord_patch_failed_${response.status}`);
  }
}

async function postFollowup(target: DiscordResponseTarget, content: string) {
  const response = await fetch(
    `${discordApiBase}/webhooks/${target.applicationId}/${target.token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: limitDiscordMessage(content),
        allowed_mentions: { parse: [] },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`discord_followup_failed_${response.status}`);
  }
}

async function callLlmForErrorTranslation(normalizedError: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "") ?? "";
  const agentAccessKey = Deno.env.get("AGENT_ACCESS_KEY") ?? "";

  if (!supabaseUrl || !agentAccessKey) {
    throw new Error("call_llm_configuration_missing");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${agentAccessKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      prompt: [
        "You will receive a system error made of a status code and an error type.",
        "Write a user-facing explanation with three parts, in two or three sentences total:",
        "1. Explain in plain language what happened.",
        "2. Based on the status code and error type, infer the one or two most likely causes. For example, 500 + database_insert_failed most likely means a database-side issue, such as a table/schema change, constraint conflict, or temporary service outage.",
        "3. Tell the user what to do now: retry, wait, or ask Max to check the function logs.",
        "Base your answer only on the provided error structure. Do not invent specific details.",
        "Do not mention secrets, keys, tokens, SQL values, captured content, or raw payloads.",
        `Normalized error: ${normalizedError}`,
      ].join("\n"),
      systemPrompt:
        "You explain sanitized operational errors to end users. Be concise, practical, and return only the user-facing explanation.",
      maxTokens: 120,
      effort: getErrorTranslateEffort(),
    }),
  });

  const bodyText = await response.text();
  let text = "";
  try {
    const parsed = JSON.parse(bodyText) as { text?: unknown; error?: unknown };
    if (typeof parsed.text === "string") {
      text = parsed.text.trim();
    }
  } catch {
    // Keep empty text; caller will treat it as translation failure.
  }

  if (!response.ok || !text) {
    throw new Error("call_llm_translation_failed");
  }

  return text;
}

async function translateAndFollowUp(target: DiscordResponseTarget, normalizedError: string) {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      throw new Error("database_configuration_missing");
    }

    const errorHash = await sha256Hex(normalizedError);
    const since = new Date(Date.now() - getErrorDedupWindowSeconds() * 1000).toISOString();
    const { data: cached, error: cacheError } = await supabase
      .from("error_translations")
      .select("translation")
      .eq("error_hash", errorHash)
      .gte("created_at", since)
      .maybeSingle();

    if (cacheError) {
      throw cacheError;
    }

    let translation = typeof cached?.translation === "string" ? cached.translation.trim() : "";
    if (!translation) {
      translation = await callLlmForErrorTranslation(normalizedError);
      const { error: upsertError } = await supabase.from("error_translations").upsert({
        error_hash: errorHash,
        translation,
        created_at: new Date().toISOString(),
      }, { onConflict: "error_hash" });

      if (upsertError) {
        throw upsertError;
      }
    }

    await postFollowup(target, `补充说明：${translation}`);
  } catch (error) {
    console.log(`discord-bot error translation skipped: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorType: string) {
  let timeoutId: number | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new CommandError(504, errorType)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function insertThought(content: string) {
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL")?.trim() ??
    Deno.env.get("DATABASE_URL")?.trim() ??
    "";

  if (!databaseUrl) {
    throw new CommandError(500, "database_configuration_missing");
  }

  const client = new Client(databaseUrl);
  await client.connect();

  try {
    const queryResult = await client.queryObject<InsertThoughtResult>`
      insert into public.thoughts (content, source)
      values (${content}, 'discord')
      on conflict (content_hash) do update
        set content_hash = excluded.content_hash
      returning id, (xmax = 0) as inserted
    `;

    const result = queryResult.rows[0];
    if (typeof result?.id !== "string" || typeof result.inserted !== "boolean") {
      throw new CommandError(500, "database_insert_result_invalid");
    }

    return result;
  } catch (error) {
    if (error instanceof CommandError) {
      throw error;
    }
    throw new CommandError(500, "database_insert_failed", error);
  } finally {
    await client.end();
  }
}

async function handleSave(interaction: DiscordInteraction) {
  const content = getStringOption(interaction, "text");

  if (!content || content.trim().length === 0) {
    throw new CommandError(400, "empty_content");
  }

  const result = await withTimeout(insertThought(content), insertTimeoutMs, "database_insert_timeout");
  return result.inserted
    ? `✅ saved (200)\nid=${result.id}`
    : `✅ already saved (dedup, 200)\nid=${result.id}`;
}

async function handleSearch(interaction: DiscordInteraction) {
  const query = getStringOption(interaction, "query");

  if (!query || query.trim().length === 0) {
    throw new CommandError(400, "empty_query");
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new CommandError(500, "database_configuration_missing");
  }

  const { data, error } = await supabase
    .from("thoughts")
    .select("id,content,created_at,source")
    .ilike("content", `%${escapeLikePattern(query)}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    throw new CommandError(500, "database_search_failed", error);
  }

  const rows = (data ?? []).map(toThoughtRow);
  if (rows.length === 0) {
    return "No matching thoughts found.";
  }

  return formatThoughtRows(rows);
}

async function handleRecent() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new CommandError(500, "database_configuration_missing");
  }

  const { data, error } = await supabase
    .from("thoughts")
    .select("id,content,created_at,source")
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    throw new CommandError(500, "database_recent_failed", error);
  }

  const rows = (data ?? []).map(toThoughtRow);
  if (rows.length === 0) {
    return "No thoughts saved yet.";
  }

  return formatThoughtRows(rows);
}

async function handleApplicationCommand(interaction: DiscordInteraction) {
  const commandName = getCommandName(interaction);

  if (commandName === "save") {
    return await handleSave(interaction);
  }

  if (commandName === "search") {
    return await handleSearch(interaction);
  }

  if (commandName === "recent") {
    return await handleRecent();
  }

  throw new CommandError(400, "unknown_command");
}

async function runDeferredCommand(target: DiscordResponseTarget, interaction: DiscordInteraction) {
  try {
    const content = await handleApplicationCommand(interaction);
    await patchOriginal(target, content);
  } catch (error) {
    const fields = getErrorFields(error);
    const normalizedError = normalizeErrorForHash(error);
    const summary = limitErrorSummary(normalizedError);
    await patchOriginal(target, `❌ failed (${fields.status}): ${summary}`);
    EdgeRuntime.waitUntil(translateAndFollowUp(target, normalizedError));
  }
}

export async function handleRequest(req: Request) {
  if (req.method !== "POST") {
    return json(405, { ok: false });
  }

  const rawBody = await req.text();

  if (!verifyDiscordSignature(req, rawBody)) {
    return empty(401);
  }

  const interaction = parseInteraction(rawBody);
  if (!interaction) {
    return json(400, { ok: false });
  }

  if (interaction.type === 1) {
    return json(200, { type: 1 });
  }

  if (interaction.type === 2) {
    const target = getResponseTarget(interaction);
    if (!target) {
      return json(400, { ok: false });
    }

    EdgeRuntime.waitUntil(runDeferredCommand(target, interaction));
    return deferredResponse();
  }

  return json(400, { ok: false });
}

Deno.serve(handleRequest);
