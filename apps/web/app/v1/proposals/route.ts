import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../lib/rest-context";
import { getBroker } from "../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../lib/rest";

export async function GET(req: NextRequest) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const url = new URL(req.url);
  const status = url.searchParams.get("status") as "pending" | "approved" | "rejected" | undefined;
  const collection = url.searchParams.get("collection") || undefined;

  const result = await getBroker().broker.listProposals(ctx, { collection, status });

  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
