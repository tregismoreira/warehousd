import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { approveGrant, denyGrant, revokeGrant, loadConfig } from "@warehousd/broker";
import { getSessionUser } from "../../../lib/session";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

export async function GET(req: NextRequest) {
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const user = sessionUser.id;
  const app = getAppPool();
  const cfg = loadConfig(projectDir);
  const mine = await app.query(`select * from app.grants where user_id=$1 order by requested_at desc`, [user]);
  const pending = await app.query(`select * from app.grants where status='pending' order by requested_at desc`);

  // Enrich grants with collection type info
  const enriched = (rows: typeof mine.rows) => rows.map(g => ({
    ...g,
    collectionType: cfg.collections[g.collection]?.type || "dataset",
    taxonomyField: cfg.collections[g.collection]?.taxonomy ?? null,
  }));

  return Response.json({ mine: enriched(mine.rows), pending: enriched(pending.rows) });
}

export async function POST(req: NextRequest) {
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { action, id, allowedFields, selectedPaths, expiresAt } = await req.json();
  const app = getAppPool();

  if (action === "request") {
    // any authenticated user may request; requester is the session user, never a body value
    // (request insertion handled elsewhere in the grants flow — kept as-is if present)
  } else {
    // approve/deny/revoke are privileged
    if (sessionUser.role !== "manager" && sessionUser.role !== "admin") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const by = sessionUser.id; // decided_by comes from the session, never the request body
  if (action === "approve") {
    const opts: any = { allowedFields, expiresAt };
    if (selectedPaths && selectedPaths.length > 0) {
      opts.rowFilter = { field: "path", op: "in", value: selectedPaths };
    }
    await approveGrant(app, id, by, opts);
  } else if (action === "deny") await denyGrant(app, id, by);
  else if (action === "revoke") await revokeGrant(app, id, by);
  return Response.json({ ok: true });
}
