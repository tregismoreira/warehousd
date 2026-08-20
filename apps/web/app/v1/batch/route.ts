import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../lib/rest-context";
import { getBroker } from "../../lib/broker";
import { unauthenticated, refuse, ok, readJson } from "../../../lib/rest";

export async function POST(req: NextRequest) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  // A malformed body is refused rather than defaulted, matching the single-collection query
  // route: there is no sensible empty-batch default to fall back to.
  const body = await readJson(req);
  if (!body.ok) return refuse("invalid_intent");

  const result = await getBroker().broker.queryBatch(ctx, body.value);
  // Sub-query refusals never change the HTTP status: the envelope succeeded, and each sub-query's
  // own { ok: false, reason, auditId } travels inside `results` at its own label. Only an
  // envelope-level refusal (malformed body, too many sub-queries, duplicate labels) reaches here.
  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
