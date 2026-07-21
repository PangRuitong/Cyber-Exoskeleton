import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const jsonHeaders = { "content-type": "application/json" };

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

async function insertThoughtDedup(content: string, source: string) {
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL")?.trim() ??
    Deno.env.get("DATABASE_URL")?.trim() ??
    "";

  if (!databaseUrl) {
    return null;
  }

  const client = new Client(databaseUrl);
  await client.connect();

  try {
    const result = await client.queryObject<{
      id: string;
      inserted: boolean;
    }>`
      insert into public.thoughts (content, source)
      values (${content}, ${source})
      on conflict (content_hash) do update
        set content_hash = excluded.content_hash
      returning id, (xmax = 0) as inserted
    `;

    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

Deno.serve(async (req) => {
  const captureToken = Deno.env.get("CAPTURE_TOKEN") ?? "";
  const expectedAuth = `Bearer ${captureToken}`;

  if (!captureToken || req.headers.get("authorization") !== expectedAuth) {
    return json(401, { ok: false });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false });
  }

  const content =
    body && typeof body === "object" && "content" in body
      ? (body as { content?: unknown }).content
      : undefined;

  if (typeof content !== "string" || content.trim().length === 0) {
    return json(400, { ok: false });
  }

  const result = await insertThoughtDedup(content, "siri");
  if (typeof result?.id !== "string" || typeof result.inserted !== "boolean") {
    return json(500, { ok: false });
  }

  return json(200, {
    ok: true,
    duplicate: !result.inserted,
    id: result.id,
  });
});
