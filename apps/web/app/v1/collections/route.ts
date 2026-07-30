import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../lib/rest-context";
import { getBroker } from "../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../lib/rest";

export async function GET(req: NextRequest) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  // An array is the listing; anything else is the refusal the broker returns when it could not
  // record the decision. Same shape check describeCollection's route uses.
  const result = await getBroker().broker.listCollections(ctx);
  if (!Array.isArray(result)) return refuse(result.reason);
  return ok(result);
}
