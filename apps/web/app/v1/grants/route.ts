import type { NextRequest } from "next/server";
import { requestGrant, validateGrantRequest } from "@warehousd/broker";
import { deriveRestContext } from "../../../lib/rest-context";
import { getBroker, getAppPool } from "../../lib/broker";
import { unauthenticated, refuse, ok, readJson } from "../../../lib/rest";

export async function GET(req: NextRequest) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const app = getAppPool();
  const r = await app.query(
    `select * from app.grants where workspace_id=$1 and user_id=$2 order by requested_at desc`,
    [ctx.workspaceId, ctx.userId],
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

  const body = await readJson(req);
  if (!body.ok) return refuse("invalid_intent");
  const { collection, purposeLabel, purposeDetail, fields } = body.value;
  // Same answer validateGrantRequest gives a collection name that isn't one — it just cannot be
  // asked the question unless the name is a string.
  if (typeof collection !== "string")
    return Response.json({ error: "unknown_collection" }, { status: 404 });
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
    workspaceId: ctx.workspaceId,
    purposeLabel: (purposeLabel as string).trim(),
    purposeDetail: typeof purposeDetail === "string" ? purposeDetail.trim() : undefined,
    allowedFields: validation.fields,
  });

  return ok({ ok: true, requestId }, 201);
}
