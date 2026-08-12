import { NextRequest } from "next/server";
import { listMemberships, memberRole } from "@warehousd/broker";
import { getAppPool } from "../../../lib/broker";
import { getSessionData } from "../../../../lib/session";
import { readJson } from "../../../../lib/rest";

// Deliberately NOT gated by requireSession/requireRole (lib/authz.ts): those enforce membership
// in the CURRENT active workspace, and this route's whole job is to inspect or change which
// workspace is active — including recovering from an active workspace the caller is no longer a
// member of. Authentication alone (getSessionData) is the right and only gate here.

export async function GET(req: NextRequest) {
  const data = await getSessionData(req);
  if (!data) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const pool = getAppPool();
  const memberships = await listMemberships(pool, data.user.id);
  const names = await pool.query<{ id: string; name: string }>(
    `select id, name from app.workspaces where id = any($1)`,
    [memberships.map((m) => m.workspaceId)],
  );
  const nameOf = new Map(names.rows.map((r) => [r.id, r.name]));

  return Response.json({
    active: data.activeWorkspaceId,
    memberships: memberships.map((m) => ({
      workspaceId: m.workspaceId,
      name: nameOf.get(m.workspaceId) ?? m.workspaceId,
      role: m.role,
    })),
  });
}

export async function POST(req: NextRequest) {
  const data = await getSessionData(req);
  if (!data) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { workspaceId } = body.value;
  if (typeof workspaceId !== "string")
    return Response.json({ error: "invalid_workspace" }, { status: 400 });

  const pool = getAppPool();
  // Membership is verified BEFORE the write — a failed check must change nothing.
  const role = await memberRole(pool, workspaceId, data.user.id);
  if (role === null) return Response.json({ error: "forbidden" }, { status: 403 });

  await pool.query(`update app.session set "activeWorkspaceId"=$2 where id=$1`, [
    data.sessionId,
    workspaceId,
  ]);
  return Response.json({ ok: true });
}
