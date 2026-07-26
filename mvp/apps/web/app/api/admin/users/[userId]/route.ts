import { NextRequest } from "next/server";
import { getAppPool } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";

const ROLES = new Set(["admin", "manager", "member"]);

export async function PATCH(
  req: NextRequest, { params }: { params: Promise<{ userId: string }> },
) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  const { userId } = await params;
  const { role } = await req.json();
  if (typeof role !== "string" || !ROLES.has(role))
    return Response.json({ error: "invalid_role" }, { status: 400 });

  const app = getAppPool();
  const cur = await app.query(`select role from app."user" where id=$1`, [userId]);
  if (cur.rowCount === 0) return Response.json({ error: "unknown_user" }, { status: 404 });

  // Two lock-out guards. Self-demotion strands the actor outside the only surface that can
  // undo it; demoting the last admin strands everyone.
  if (userId === guard.user.id && role !== "admin")
    return Response.json({ error: "cannot_demote_self" }, { status: 400 });
  if (cur.rows[0].role === "admin" && role !== "admin") {
    const admins = await app.query(`select count(*)::int as n from app."user" where role='admin'`);
    if (admins.rows[0].n <= 1)
      return Response.json({ error: "cannot_demote_last_admin" }, { status: 400 });
  }

  await app.query(`update app."user" set role=$2 where id=$1`, [userId, role]);
  return Response.json({ ok: true });
}
