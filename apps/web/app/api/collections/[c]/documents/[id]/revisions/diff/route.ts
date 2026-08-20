import type { NextRequest } from "next/server";
import { deriveContext } from "../../../../../../../../lib/session";
import { getBroker } from "../../../../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../../../../lib/rest";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> },
) {
  const ctx = await deriveContext(req);
  if (!ctx) return unauthenticated();

  const { c, id } = await params;
  // new URL(req.url) rather than req.nextUrl — see the matching comment on the /v1 diff route.
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return refuse("invalid_intent");

  const result = await getBroker().broker.diffRevisions(ctx, { collection: c, id, from, to });

  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
