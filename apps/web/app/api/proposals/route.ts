import { NextRequest } from "next/server";
import { deriveContext } from "../../../lib/session";
import { getBroker } from "../../lib/broker";
import { refuse, ok, unauthenticated } from "../../../lib/rest";

export async function GET(req: NextRequest) {
  const ctx = await deriveContext(req);
  if (!ctx) return unauthenticated();

  const url = new URL(req.url);
  const status = url.searchParams.get("status") as
    | "pending"
    | "approved"
    | "rejected"
    | undefined;
  const collection = url.searchParams.get("collection") || undefined;

  const result = await getBroker().broker.listProposals(ctx, {
    collection,
    status,
  });

  if (!result.ok) return refuse(result.reason);

  return ok(result);
}
