import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../../../lib/rest-context";
import { getBroker } from "../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../lib/rest";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { id } = await params;
  const result = await getBroker().broker.approveProposal(ctx, id);

  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
