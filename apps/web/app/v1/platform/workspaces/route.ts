import { NextRequest } from "next/server";
import { setMember } from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../lib/broker";
import {
  derivePlatformCaller,
  platformDisabled,
  platformUnauthenticated,
  platformAuditWriter,
} from "../../../../lib/platform-context";

// A workspace id is a database identifier used unquoted nowhere, but it does become part of the
// audit trail and the console URL, so the same shape as a collection identifier is required
// rather than merely convenient.
const WORKSPACE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export async function POST(req: NextRequest) {
  const auth = await derivePlatformCaller(req);
  if (!auth.ok) return auth.reason === "disabled" ? platformDisabled() : platformUnauthenticated();

  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null)
    return Response.json({ error: "invalid_body" }, { status: 400 });
  const { id, name, admin } = body as Record<string, unknown>;

  if (typeof id !== "string" || !WORKSPACE_ID_RE.test(id))
    return Response.json({ error: "invalid_id" }, { status: 400 });
  if (typeof name !== "string" || !name.trim())
    return Response.json({ error: "invalid_name" }, { status: 400 });
  if (
    typeof admin !== "object" ||
    admin === null ||
    typeof (admin as Record<string, unknown>).userId !== "string"
  )
    return Response.json({ error: "invalid_admin" }, { status: 400 });
  const adminUserId = (admin as { userId: string }).userId;

  const app = getAppPool();
  const cfg = getConfig();
  const writer = platformAuditWriter(app, cfg, auth.caller.keyId, id);

  const existing = await app.query(`select 1 from app.workspaces where id=$1`, [id]);
  if ((existing.rowCount ?? 0) > 0) {
    await writer.refuse(null, "workspace_exists", { intent: { op: "workspace_created", id } });
    return Response.json({ error: "workspace_exists" }, { status: 409 });
  }

  await app.query(`insert into app.workspaces (id, name, created_by_key) values ($1,$2,$3)`, [
    id,
    name,
    auth.caller.keyId,
  ]);
  await setMember(app, { workspaceId: id, userId: adminUserId, role: "admin" });

  // null managedWorkspaces already reaches every workspace; only a scoped key needs the new id
  // added to its own ACL so it can manage the tenant it just created.
  if (auth.caller.managedWorkspaces !== null) {
    await app.query(
      `update app.platform_keys set managed_workspaces = array_append(managed_workspaces, $2)
       where id=$1`,
      [auth.caller.keyId, id],
    );
  }

  await writer.allow(null, { intent: { op: "workspace_created", id, name, adminUserId } });

  return Response.json({ id, name }, { status: 201 });
}

// Only the key's own managed_workspaces (or every workspace, when null) — never the whole
// deployment. A key scoped to one consuming app must not be able to enumerate another's tenants.
export async function GET(req: NextRequest) {
  const auth = await derivePlatformCaller(req);
  if (!auth.ok) return auth.reason === "disabled" ? platformDisabled() : platformUnauthenticated();

  const app = getAppPool();
  const r =
    auth.caller.managedWorkspaces === null
      ? await app.query(`select id, name, created_at from app.workspaces order by id`)
      : await app.query(
          `select id, name, created_at from app.workspaces where id = any($1) order by id`,
          [auth.caller.managedWorkspaces],
        );

  return Response.json({ workspaces: r.rows });
}
