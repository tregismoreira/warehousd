import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { approveGrant, denyGrant, revokeGrant, loadConfig, requestGrant, grantableFields, findCollection } from "@warehousd/broker";
import { requireSession, requireRole, atLeast } from "../../../lib/authz";
import { readEnvCookie } from "../../../lib/session";
import { buildApproval } from "../../../lib/approve";

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

  const active = atLeast(user.role, "manager")
    ? await app.query(
        `select * from app.grants where status='approved' order by decided_at desc nulls last`)
    : { rows: [] as typeof mine.rows };

  const enriched = (rows: typeof mine.rows) => rows.map((g) => ({
    ...g,
    collectionType: cfg.collections[g.collection]?.type || "dataset",
    taxonomyField: cfg.collections[g.collection]?.taxonomy ?? null,
  }));

  return Response.json({
    mine: enriched(mine.rows),
    pending: enriched(pending.rows),
    active: enriched(active.rows),
  });
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
    const c = findCollection(cfg, collection);
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
    const cur = await app.query(
      `select collection, allowed_fields, status from app.grants where id=$1`, [body.id]);
    const row = cur.rows[0];
    if (!row) return Response.json({ error: "unknown_grant" }, { status: 404 });
    if (row.status !== "pending") return Response.json({ error: "not_pending" }, { status: 409 });

    const built = buildApproval(cfg, row.allowed_fields ?? [], {
      collection: row.collection,
      allowedFields: body.allowedFields,
      expiresAt: body.expiresAt,
      selectedPaths: body.selectedPaths,
      selectedTerms: body.selectedTerms,
    });
    if (!built.ok) return Response.json({ error: built.error }, { status: 400 });

    await approveGrant(app, body.id, by, built.opts);
    return Response.json({ ok: true });
  }
  if (action === "deny") { await denyGrant(app, body.id, by); return Response.json({ ok: true }); }
  if (action === "revoke") { await revokeGrant(app, body.id, by); return Response.json({ ok: true }); }
  return Response.json({ error: "unknown_action" }, { status: 400 });
}
