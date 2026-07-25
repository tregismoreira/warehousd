import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { approveGrant, denyGrant, revokeGrant, loadConfig } from "@warehousd/broker";
import { requireSession, atLeast } from "../../../lib/authz";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const user = guard.user;
  const app = getAppPool();
  const cfg = loadConfig(projectDir);
  const mine = await app.query(
    `select * from app.grants where user_id=$1 order by requested_at desc`, [user.id]);
  // The pending queue is approver-only data: it names who asked for what, and why. A member
  // calling this endpoint directly used to receive the whole organisation's queue.
  const pending = atLeast(user.role, "manager")
    ? await app.query(`select * from app.grants where status='pending' order by requested_at desc`)
    : { rows: [] as typeof mine.rows };

  const enriched = (rows: typeof mine.rows) => rows.map((g) => ({
    ...g,
    collectionType: cfg.collections[g.collection]?.type || "dataset",
    taxonomyField: cfg.collections[g.collection]?.taxonomy ?? null,
  }));

  return Response.json({ mine: enriched(mine.rows), pending: enriched(pending.rows) });
}

export async function POST(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const sessionUser = guard.user;
  const { action, id, allowedFields, selectedPaths, expiresAt } = await req.json();
  const app = getAppPool();

  if (action === "request") {
    // any authenticated user may request; requester is the session user, never a body value
    // (request insertion handled elsewhere in the grants flow — kept as-is if present)
  } else {
    // approve/deny/revoke are privileged
    if (!atLeast(sessionUser.role, "manager")) {
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
