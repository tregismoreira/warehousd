import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../../../../../../lib/rest-context";
import { getBroker } from "../../../../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../../../../lib/rest";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string; rev: string }> },
) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c, id, rev } = await params;
  const result = await getBroker().broker.getRevision(ctx, { collection: c, id, rev });

  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
