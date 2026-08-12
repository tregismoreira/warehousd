import { NextRequest } from "next/server";
import { mayManageWorkspace, declaredTables, withWorkspace } from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../../lib/broker";
import {
  derivePlatformCaller,
  platformDisabled,
  platformUnauthenticated,
  platformAuditWriter,
} from "../../../../../lib/platform-context";

type Ctx = { params: Promise<{ id: string }> };

// A key that does not manage `{id}` gets 404, not 403: a 403 confirms the workspace exists, which
// is exactly the enumeration a scoped key must not be able to do against a tenant that isn't its
// own.
function notManaged(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await derivePlatformCaller(req);
  if (!auth.ok) return auth.reason === "disabled" ? platformDisabled() : platformUnauthenticated();
  const { id } = await ctx.params;
  if (!mayManageWorkspace(auth.caller, id)) return notManaged();

  const app = getAppPool();
  const r = await app.query(`select id, name, created_at from app.workspaces where id=$1`, [id]);
  if (r.rowCount === 0) return notManaged();

  return Response.json(r.rows[0]);
}

// Removes the tenant's data rows in both envs, then the app.workspaces row itself — never just
// the row. See migration 0011 for why the FKs this depends on are shaped the way they are: the
// audit trail survives a deleted workspace on purpose, grants and client policies do not.
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await derivePlatformCaller(req);
  if (!auth.ok) return auth.reason === "disabled" ? platformDisabled() : platformUnauthenticated();
  const { id } = await ctx.params;
  if (!mayManageWorkspace(auth.caller, id)) return notManaged();

  const app = getAppPool();
  const cfg = getConfig();
  const writer = platformAuditWriter(app, cfg, auth.caller.keyId, id);

  const existing = await app.query(`select 1 from app.workspaces where id=$1`, [id]);
  if (existing.rowCount === 0) return notManaged();

  // Audited BEFORE the row is removed: audit_events.workspace_id still has to name a real row at
  // insert time for every OTHER FK'd table, and recording "this workspace was deleted" after the
  // fact would leave the trail's own account of the deletion with nowhere valid to point.
  await writer.allow(null, { intent: { op: "workspace_deleted", id } });

  // The data schemas carry no FK to app.workspaces — nothing cascades them. Every declared table,
  // in both envs, swept explicitly before the row goes.
  const tables = new Set<string>();
  for (const name of Object.keys(cfg.collections))
    for (const t of declaredTables(name, cfg)) tables.add(t.table);

  for (const schema of ["data_synth", "data_live"] as const) {
    await withWorkspace(app, id, async (client) => {
      for (const table of tables) {
        await client.query(`delete from ${schema}.${table} where workspace_id = $1`, [id]);
      }
      // The per-document ACL table is shared across every collection in the schema, not declared
      // per-collection, so it is swept once here rather than picked up by the loop above.
      await client.query(`delete from ${schema}."_acl" where workspace_id = $1`, [id]);
    });
  }

  // app.grants and app.client_policies (and, through it, app.client_secrets) cascade from the
  // workspaces row itself — see migration 0011. app.workspace_members already did, from 0009.
  await app.query(`delete from app.workspaces where id=$1`, [id]);

  return new Response(null, { status: 204 });
}
