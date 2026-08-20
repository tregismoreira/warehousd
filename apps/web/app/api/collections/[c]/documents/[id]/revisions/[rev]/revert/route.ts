import type { NextRequest } from "next/server";
import { deriveContext } from "../../../../../../../../../lib/session";
import { getBroker } from "../../../../../../../../lib/broker";
import { unauthenticated, refuse, ok, mutationStatus } from "../../../../../../../../../lib/rest";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string; rev: string }> },
) {
  const ctx = await deriveContext(req);
  if (!ctx) return unauthenticated();

  const { c, id, rev } = await params;
  const ifMatch = req.headers.get("If-Match");
  // Strip quotes from If-Match (RFC 7232 format: "value") — same convention as the PUT route.
  const expect = ifMatch ? ifMatch.replace(/^"|"$/g, "") : undefined;

  const result = await getBroker().broker.revertDocument(ctx, {
    collection: c,
    id,
    rev,
    ...(expect ? { expect } : {}),
  });

  if (!result.ok) return refuse(result.reason, !!ifMatch);

  if (result.status === "noop") return new Response(null, { status: 204 });
  const response = ok(result, mutationStatus(result.status));
  if (result.status === "applied") response.headers.set("ETag", `"${result.rev}"`);
  return response;
}
