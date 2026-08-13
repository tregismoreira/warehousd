import { NextRequest } from "next/server";
import {
  listMembers,
  setMember,
  removeMember,
  memberRole,
  LastAdminRemoval,
  WORKSPACE_ROLES,
  workspacesEnabled,
  type WorkspaceRole,
} from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { readJson } from "../../../../lib/rest";

// Mounted only when workspaces.enabled is true — a bare 404 when it is off, same rule as
// /v1/platform/* (platform-context.ts): an unmounted surface should look unmounted, not
// forbidden. Checked first, before the session/role gate, so a probe against this route
// learns nothing about whether the caller would otherwise be allowed.
function disabled(): Response {
  return new Response(null, { status: 404 });
}

export async function GET(req: NextRequest) {
  if (!workspacesEnabled(getConfig())) return disabled();
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  const members = await listMembers(getAppPool(), guard.workspaceId);
  return Response.json({ members });
}

// Adds an EXISTING user (one who already has an account — from another workspace, SSO, or a
// prior signup) as a member of this workspace, or changes their role in it if they already are
// one. There is no invite-by-email-that-does-not-exist-yet flow: account creation stays where it
// already is (signup, SSO JIT-provisioning), and this only ever reaches app.workspace_members.
export async function POST(req: NextRequest) {
  if (!workspacesEnabled(getConfig())) return disabled();
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { email, role } = body.value;
  if (typeof email !== "string" || !email.trim())
    return Response.json({ error: "invalid_email" }, { status: 400 });
  if (typeof role !== "string" || !WORKSPACE_ROLES.includes(role as WorkspaceRole))
    return Response.json({ error: "invalid_role" }, { status: 400 });

  const app = getAppPool();
  const user = await app.query(`select id from app."user" where email=$1`, [email.trim()]);
  const row = user.rows[0];
  if (!row) return Response.json({ error: "unknown_email" }, { status: 404 });
  const userId = row.id as string;

  // A role change away from admin can strand a workspace exactly the way removing its last
  // admin can — this is that same guard, reached through the other door. Only applies to an
  // EXISTING member: adding someone new can never be the thing that removes the last admin.
  const currentRole = await memberRole(app, guard.workspaceId, userId);
  if (currentRole === "admin" && role !== "admin") {
    const admins = await app.query(
      `select count(*)::int as n from app.workspace_members where workspace_id=$1 and role='admin'`,
      [guard.workspaceId],
    );
    if (admins.rows[0].n <= 1)
      return Response.json({ error: "cannot_demote_last_admin" }, { status: 400 });
  }

  await setMember(app, { workspaceId: guard.workspaceId, userId, role: role as WorkspaceRole });
  return Response.json({ ok: true, userId, role }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  if (!workspacesEnabled(getConfig())) return disabled();
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId") ?? "";
  if (!userId) return Response.json({ error: "invalid_user_id" }, { status: 400 });

  // No self-removal guard: leaving a workspace you administer is a legitimate action (unlike
  // self-demotion in the role route, which stops here on purpose). removeMember's own
  // LastAdminRemoval is what actually protects the workspace — the case that matters is the
  // sole admin trying to remove themselves, which is exactly self-removal, so a guard here would
  // make that check unreachable rather than redundant.
  try {
    const removed = await removeMember(getAppPool(), { workspaceId: guard.workspaceId, userId });
    if (!removed) return Response.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    if (err instanceof LastAdminRemoval)
      return Response.json({ error: "last_admin" }, { status: 409 });
    throw err;
  }
  return new Response(null, { status: 204 });
}
