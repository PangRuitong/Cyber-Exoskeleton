import { createClient } from "jsr:@supabase/supabase-js@2";

const jsonHeaders = { "content-type": "application/json" };

function json(status: number, body: { ok: boolean }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, { ok: false });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { error } = await supabase.from("thoughts").insert({
    content,
    source: "siri",
  });

  if (error) {
    return json(500, { ok: false });
  }

  return json(200, { ok: true });
});
