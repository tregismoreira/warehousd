import { NextRequest } from "next/server";
import { getSessionUser } from "../../../lib/session";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { env } = await req.json();
  if (env !== "dev" && env !== "live") return Response.json({ error: "invalid env" }, { status: 400 });
  const res = Response.json({ ok: true, env });
  res.headers.append(
    "set-cookie",
    `wh_env=${env}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );
  return res;
}
