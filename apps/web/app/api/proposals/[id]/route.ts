import { NextRequest } from "next/server";
import { deriveContext } from "../../../../lib/session";
import { getBroker } from "../../../lib/broker";
import { refuse, ok, unauthenticated } from "../../../../lib/rest";

// The proposed content of one pending revision, for the human reviewing it. Grant-checked in
// the broker — a reviewer sees a value only where their own grant allows that field.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await deriveContext(req);
  if (!ctx) return unauthenticated();

  const { id } = await params;
  const result = await getBroker().broker.getProposal(ctx, id);

  if (!result.ok) return refuse(result.reason);

  return ok(result);
}
