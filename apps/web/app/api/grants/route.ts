import { NextRequest } from "next/server";
import { getAppPool, getConfig } from "../../lib/broker";
import { approveGrant, denyGrant, revokeGrant, requestGrant, validateGrantRequest } from "@warehousd/broker";
import { requireSession, requireRole, atLeast } from "../../../lib/authz";
import { readEnvCookie } from "../../../lib/session";
import { buildApproval } from "../../../lib/approve";

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const user = guard.user;
  const app = getAppPool();
  const cfg = getConfig();
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
  const cfg = getConfig();

  if (action === "request") {
    // Any authenticated user may ask. Requester and env come from the session and the signed
    // cookie — a userId or env in the body is never read.
    const { collection, purposeLabel, purposeDetail, fields } = body;

    const validation = validateGrantRequest(cfg, collection, purposeLabel, fields);
    if (!validation.ok)
      return Response.json({ error: validation.error }, { status: 400 });

    const requestId = await requestGrant(app, {
      userId: user.id,
      collection,
      env: readEnvCookie(req),
      orgId: user.orgId ?? "default",
      purposeLabel: (purposeLabel as string).trim(),
      purposeDetail: typeof purposeDetail === "string" ? purposeDetail.trim() : undefined,
      allowedFields: validation.fields,
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

    const approved = await approveGrant(app, cfg, body.id, by, { ...built.opts, verbs: body.verbs });
    if (!approved.ok)
      return Response.json({ error: approved.error },
        { status: approved.error === "unknown_grant" ? 404 : 400 });
    return Response.json({ ok: true });
  }
  if (action === "deny") {
    const denied = await denyGrant(app, body.id, by);
    if (!denied) return Response.json({ error: "unknown_grant" }, { status: 404 });
    return Response.json({ ok: true });
  }
  if (action === "revoke") {
    const revoked = await revokeGrant(app, body.id, by);
    if (!revoked) return Response.json({ error: "unknown_grant" }, { status: 404 });
    return Response.json({ ok: true });
  }
  return Response.json({ error: "unknown_action" }, { status: 400 });
}
