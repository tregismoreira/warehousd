import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { approveGrant, denyGrant, revokeGrant, loadConfig, requestGrant, grantableFields } from "@warehousd/broker";
import { requireSession, requireRole } from "../../../lib/authz";
import { readEnvCookie } from "../../../lib/session";

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
  const isManager = user.role === "manager" || user.role === "admin";
  const pending = isManager
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
  const user = guard.user;
  const body = await req.json();
  const { action } = body;
  const app = getAppPool();
  const cfg = loadConfig(projectDir);

  if (action === "request") {
    // Any authenticated user may ask. Requester and env come from the session and the signed
    // cookie — a userId or env in the body is never read.
    const { collection, purposeLabel, purposeDetail, fields } = body;
    const c = cfg.collections[collection];
    if (!c) return Response.json({ error: "unknown_collection" }, { status: 400 });
    if (typeof purposeLabel !== "string" || !purposeLabel.trim())
      return Response.json({ error: "purpose_required" }, { status: 400 });

    const grantable = grantableFields(cfg, collection);
    const requested: string[] = Array.isArray(fields) && fields.length ? fields : grantable;
    // Two-tier deny (§5.3): a posture:deny field can never be granted, so it can never even
    // be requested. Refusing here keeps unaskable fields out of the approver's inbox.
    for (const f of requested)
      if (!grantable.includes(f))
        return Response.json({ error: "field_not_grantable" }, { status: 400 });

    const requestId = await requestGrant(app, {
      userId: user.id,
      collection,
      env: readEnvCookie(req),
      purposeLabel: purposeLabel.trim(),
      purposeDetail: typeof purposeDetail === "string" ? purposeDetail.trim() : undefined,
      allowedFields: requested,
    });
    return Response.json({ ok: true, requestId });
  }

  // approve/deny/revoke are privileged.
  const priv = await requireRole(req, "manager");
  if (!priv.ok) return priv.response;
  const by = user.id; // decided_by comes from the session, never the request body

  if (action === "approve") {
    const opts: any = { allowedFields: body.allowedFields, expiresAt: body.expiresAt };
    if (body.selectedPaths && body.selectedPaths.length > 0)
      opts.rowFilter = { field: "path", op: "in", value: body.selectedPaths };
    await approveGrant(app, body.id, by, opts);
    return Response.json({ ok: true });
  }
  if (action === "deny") { await denyGrant(app, body.id, by); return Response.json({ ok: true }); }
  if (action === "revoke") { await revokeGrant(app, body.id, by); return Response.json({ ok: true }); }
  return Response.json({ error: "unknown_action" }, { status: 400 });
}
