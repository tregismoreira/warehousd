import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../../../../../lib/rest-context";
import { getBroker } from "../../../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../../../lib/rest";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> },
) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c, id } = await params;
  const result = await getBroker().broker.listRevisions(ctx, { collection: c, id });

  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
