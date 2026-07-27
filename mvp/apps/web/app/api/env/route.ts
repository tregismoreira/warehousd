import { NextRequest } from "next/server";
import { getSessionUser } from "../../../lib/session";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { env } = await req.json();
  if (env !== "dev" && env !== "live") return Response.json({ error: "invalid env" }, { status: 400 });
  const res = Response.json({ ok: true, env });

  // Determine if the request is over HTTPS (check req.url protocol and x-forwarded-proto header)
  const url = new URL(req.url);
  const isHttps = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

  let cookieValue = `wh_env=${env}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
  if (isHttps) cookieValue += "; Secure";

  res.headers.append("set-cookie", cookieValue);
  return res;
}
