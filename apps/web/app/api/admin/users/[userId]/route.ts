import { NextRequest } from "next/server";
import { setMember } from "@warehousd/broker";
import { getAppPool } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";
import { readJson } from "../../../../../lib/rest";

const ROLES = new Set(["admin", "manager", "member"]);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  const { userId } = await params;
  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { role } = body.value;
  if (typeof role !== "string" || !ROLES.has(role))
    return Response.json({ error: "invalid_role" }, { status: 400 });

  const app = getAppPool();
  // Every statement below is scoped to the acting admin's workspace. None of them was: the lookup and
  // the update matched on user id alone, so an admin of one workspace could read and rewrite the role of
  // a user in another — and the last-admin count spanned all workspaces, so workspace A's admins could satisfy
  // the guard while workspace B demoted its own last one. The sibling listing route
  // (../route.ts) already filters by "workspaceId"; this one is the write.
  const workspace = guard.workspaceId;
  const cur = await app.query(`select role from app."user" where id=$1 and "workspaceId"=$2`, [
    userId,
    workspace,
  ]);
  // A user outside the caller's workspace is reported as unknown rather than forbidden: which ids exist
  // elsewhere is not this admin's to learn.
  if (cur.rowCount === 0) return Response.json({ error: "unknown_user" }, { status: 404 });

  // Two lock-out guards. Self-demotion strands the actor outside the only surface that can
  // undo it; demoting the last admin strands everyone.
  if (userId === guard.user.id && role !== "admin")
    return Response.json({ error: "cannot_demote_self" }, { status: 400 });
  if (cur.rows[0].role === "admin" && role !== "admin") {
    const admins = await app.query(
      `select count(*)::int as n from app."user" where role='admin' and "workspaceId"=$1`,
      [workspace],
    );
    if (admins.rows[0].n <= 1)
      return Response.json({ error: "cannot_demote_last_admin" }, { status: 400 });
  }

  await app.query(`update app."user" set role=$2 where id=$1 and "workspaceId"=$3`, [
    userId,
    role,
    workspace,
  ]);
  // Authorization reads app.workspace_members (see lib/authz.ts), not this column — a promotion
  // that stopped here would change what the console displays without changing what the promoted
  // user can actually do. Kept in sync until the listing route itself reads membership directly
  // (PR 6 makes admin/users per-workspace end to end).
  await setMember(app, {
    workspaceId: workspace,
    userId,
    role: role as "admin" | "manager" | "member",
  });
  return Response.json({ ok: true });
}
