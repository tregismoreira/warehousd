import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../../lib/rest-context";
import { getBroker } from "../../../lib/broker";
import { unauthenticated, refuse, readJson, restStatus } from "../../../../lib/rest";

export async function POST(req: NextRequest) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  // A malformed body is refused rather than defaulted, matching the query route: there is no
  // sensible empty-batch default to fall back to.
  const body = await readJson(req);
  if (!body.ok) return refuse("invalid_intent");

  const result = await getBroker().broker.decideProposals(ctx, body.value);
  // The refusal body is the full batch envelope, not refuse()'s bare `{ error }` — the caller
  // needs failedProposalId and the per-proposal outcomes to know what to retry.
  // `failedProposalId` is not a disclosure: the caller supplied it in the request.
  return Response.json(result, { status: result.ok ? 200 : restStatus(result.reason) });
}
