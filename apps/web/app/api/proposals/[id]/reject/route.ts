import { NextRequest } from "next/server";
import { deriveContext } from "../../../../../lib/session";
import { getBroker } from "../../../../lib/broker";
import { refuse, ok, unauthenticated } from "../../../../../lib/rest";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await deriveContext(req);
  if (!ctx) return unauthenticated();

  const { id } = await params;
  const result = await getBroker().broker.rejectProposal(ctx, id);

  if (!result.ok) return refuse(result.reason);

  return ok(result);
}
