import { NextRequest } from "next/server";
import { requireSession } from "../../../lib/authz";
import { readJson } from "../../../lib/rest";

export async function POST(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { env } = body.value;
  if (env !== "dev" && env !== "live")
    return Response.json({ error: "invalid_env" }, { status: 400 });
  const res = Response.json({ ok: true, env });

  // Determine if the request is over HTTPS (check req.url protocol and x-forwarded-proto header)
  const url = new URL(req.url);
  const isHttps = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

  let cookieValue = `wh_env=${env}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
  if (isHttps) cookieValue += "; Secure";

  res.headers.append("set-cookie", cookieValue);
  return res;
}
