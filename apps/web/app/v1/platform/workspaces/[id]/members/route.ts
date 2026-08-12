import { NextRequest } from "next/server";
import {
  mayManageWorkspace,
  setMember,
  removeMember,
  listMembers,
  LastAdminRemoval,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../../../lib/broker";
import {
  derivePlatformCaller,
  platformDisabled,
  platformUnauthenticated,
  platformAuditWriter,
} from "../../../../../../lib/platform-context";

type Ctx = { params: Promise<{ id: string }> };

function notManaged(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

async function requireManaged(req: NextRequest, workspaceId: string) {
  const auth = await derivePlatformCaller(req);
  if (!auth.ok)
    return {
      ok: false as const,
      response: auth.reason === "disabled" ? platformDisabled() : platformUnauthenticated(),
    };
  if (!mayManageWorkspace(auth.caller, workspaceId))
    return { ok: false as const, response: notManaged() };
  const app = getAppPool();
  const exists = await app.query(`select 1 from app.workspaces where id=$1`, [workspaceId]);
  if (exists.rowCount === 0) return { ok: false as const, response: notManaged() };
  return { ok: true as const, caller: auth.caller, app };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const guard = await requireManaged(req, id);
  if (!guard.ok) return guard.response;

  const members = await listMembers(guard.app, id);
  return Response.json({ members });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const guard = await requireManaged(req, id);
  if (!guard.ok) return guard.response;

  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null)
    return Response.json({ error: "invalid_body" }, { status: 400 });
  const { userId, role } = body as Record<string, unknown>;
  if (typeof userId !== "string" || !userId)
    return Response.json({ error: "invalid_user_id" }, { status: 400 });
  if (typeof role !== "string" || !WORKSPACE_ROLES.includes(role as WorkspaceRole))
    return Response.json({ error: "invalid_role" }, { status: 400 });

  const cfg = getConfig();
  const writer = platformAuditWriter(guard.app, cfg, guard.caller.keyId, id);
  await setMember(guard.app, { workspaceId: id, userId, role: role as WorkspaceRole });
  await writer.allow(null, { intent: { op: "member_set", id, userId, role } });

  return Response.json({ ok: true, userId, role });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const guard = await requireManaged(req, id);
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId") ?? "";
  if (!userId) return Response.json({ error: "invalid_user_id" }, { status: 400 });

  const cfg = getConfig();
  const writer = platformAuditWriter(guard.app, cfg, guard.caller.keyId, id);
  try {
    const removed = await removeMember(guard.app, { workspaceId: id, userId });
    if (!removed) return Response.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    if (err instanceof LastAdminRemoval) {
      await writer.refuse(null, "last_admin", { intent: { op: "member_removed", id, userId } });
      return Response.json({ error: "last_admin" }, { status: 409 });
    }
    throw err;
  }
  await writer.allow(null, { intent: { op: "member_removed", id, userId } });

  return new Response(null, { status: 204 });
}
