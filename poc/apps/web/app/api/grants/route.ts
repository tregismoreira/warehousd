import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { approveGrant, denyGrant, revokeGrant } from "@warehousd/broker";

export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get("user") ?? "";
  const app = getAppPool();
  const mine = await app.query(`select * from app.grants where user_id=$1 order by requested_at desc`, [user]);
  const pending = await app.query(`select * from app.grants where status='pending' order by requested_at desc`);
  return Response.json({ mine: mine.rows, pending: pending.rows });
}

export async function POST(req: NextRequest) {
  const { action, id, by, allowedFields, expiresAt } = await req.json();
  const app = getAppPool();
  if (action === "approve") await approveGrant(app, id, by, { allowedFields, expiresAt });
  else if (action === "deny") await denyGrant(app, id, by);
  else if (action === "revoke") await revokeGrant(app, id, by);
  return Response.json({ ok: true });
}
