import { createClient } from "jsr:@supabase/supabase-js@2";
import nacl from "npm:tweetnacl@1.0.3";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const encoder = new TextEncoder();
const maxDiscordContentChars = 1900;
const maxThoughtPreviewChars = 500;

type DiscordInteraction = {
  type?: unknown;
  data?: {
    name?: unknown;
    options?: DiscordOption[];
  };
};

type DiscordOption = {
  name?: unknown;
  value?: unknown;
};

type ThoughtRow = {
  id: string;
  content: string;
  created_at: string;
  source: string | null;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function interactionResponse(content: string) {
  return json(200, {
    type: 4,
    data: {
      content: limitDiscordMessage(content),
      allowed_mentions: { parse: [] },
      flags: 64,
    },
  });
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

function formatPreview(row: ThoughtRow) {
  if (row.content.length <= maxThoughtPreviewChars) {
    return row.content;
  }

  const remainingChars = row.content.length - maxThoughtPreviewChars;
  return `${row.content.slice(0, maxThoughtPreviewChars)}...[还有 ${remainingChars} 字符,完整内容见 thought id=${row.id}]`;
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
      lines.push(`...[结果过长,仅显示前 ${lines.length} 条]`);
      break;
    }

    lines.push(nextLine);
  }

  return lines.join("\n\n");
}

function toThoughtRow(value: unknown): ThoughtRow {
  return value as ThoughtRow;
}

async function handleSave(interaction: DiscordInteraction) {
  const content = getStringOption(interaction, "text");

  if (!content || content.trim().length === 0) {
    return interactionResponse("保存失败：内容不能为空。");
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return interactionResponse("保存失败，请稍后再试。");
  }

  const { error } = await supabase.from("thoughts").insert({
    content,
    source: "discord",
  });

  if (error) {
    return interactionResponse("保存失败，请稍后再试。");
  }

  const preview =
    content.length > 50 ? `${content.slice(0, 50)}...` : content;
  return interactionResponse(`已保存：${preview}`);
}

async function handleSearch(interaction: DiscordInteraction) {
  const query = getStringOption(interaction, "query");

  if (!query || query.trim().length === 0) {
    return interactionResponse("查询失败：关键词不能为空。");
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return interactionResponse("查询失败，请稍后再试。");
  }

  const { data, error } = await supabase
    .from("thoughts")
    .select("id,content,created_at,source")
    .ilike("content", `%${escapeLikePattern(query)}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    return interactionResponse("查询失败，请稍后再试。");
  }

  const rows = (data ?? []).map(toThoughtRow);
  if (rows.length === 0) {
    return interactionResponse("没有找到匹配的想法。");
  }

  return interactionResponse(formatThoughtRows(rows));
}

async function handleRecent() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return interactionResponse("查询失败，请稍后再试。");
  }

  const { data, error } = await supabase
    .from("thoughts")
    .select("id,content,created_at,source")
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    return interactionResponse("查询失败，请稍后再试。");
  }

  const rows = (data ?? []).map(toThoughtRow);
  if (rows.length === 0) {
    return interactionResponse("还没有保存任何想法。");
  }

  return interactionResponse(formatThoughtRows(rows));
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

  return interactionResponse("未知命令。");
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
    return await handleApplicationCommand(interaction);
  }

  return interactionResponse("暂不支持这种 Discord interaction。");
}

Deno.serve(handleRequest);
