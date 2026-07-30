import type { NextRequest } from "next/server";
import { requestGrant, validateGrantRequest } from "@warehousd/broker";
import { deriveRestContext } from "../../../lib/rest-context";
import { getBroker, getAppPool } from "../../lib/broker";
import { unauthenticated, ok } from "../../../lib/rest";

export async function GET(req: NextRequest) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const app = getAppPool();
  const r = await app.query(
    `select * from app.grants where org_id=$1 and user_id=$2 order by requested_at desc`,
    [ctx.orgId, ctx.userId],
  );

  const now = Date.now();
  const { cfg } = getBroker();

  const grants = r.rows.map((g) => {
    const expired =
      g.status === "approved" && g.expires_at !== null && new Date(g.expires_at).getTime() <= now;
    const c = cfg.collections[g.collection];
    return {
      ...g,
      effectiveStatus: expired ? "expired" : g.status,
      collectionType: c?.type ?? "dataset",
      taxonomyFields: c?.taxonomies ?? [],
    };
  });

  return ok({ grants });
}

export async function POST(req: NextRequest) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const body = await req.json();
  const { collection, purposeLabel, purposeDetail, fields } = body;
  const cfg = getBroker().cfg;

  const validation = validateGrantRequest(cfg, collection, purposeLabel, fields);
  if (!validation.ok) {
    // Map validation errors to HTTP status codes
    if (validation.error === "unknown_collection")
      return Response.json({ error: validation.error }, { status: 404 });
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const app = getAppPool();
  const requestId = await requestGrant(app, {
    userId: ctx.userId,
    collection,
    env: ctx.env,
    orgId: ctx.orgId,
    purposeLabel: (purposeLabel as string).trim(),
    purposeDetail: typeof purposeDetail === "string" ? purposeDetail.trim() : undefined,
    allowedFields: validation.fields,
  });

  return ok({ ok: true, requestId }, 201);
}
