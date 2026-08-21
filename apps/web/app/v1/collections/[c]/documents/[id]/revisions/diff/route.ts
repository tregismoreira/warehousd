import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../../../../../../lib/rest-context";
import { getBroker } from "../../../../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../../../../lib/rest";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> },
) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c, id } = await params;
  // new URL(req.url) rather than req.nextUrl: every other query-param route in this app reads it
  // this way (see apps/web/app/v1/collections/[c]/search/route.ts), which is what keeps a route
  // drivable from a bare Request in a test instead of requiring a real NextRequest.
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  // Two required query parameters. Absent is a malformed request, not a refusal the broker can
  // describe — it never saw an intent — so this is the one check the route makes itself.
  if (!from || !to) return refuse("invalid_intent");

  const result = await getBroker().broker.diffRevisions(ctx, { collection: c, id, from, to });

  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
