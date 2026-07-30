import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../lib/rest-context";
import { getBroker } from "../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../lib/rest";

export async function GET(req: NextRequest) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const url = new URL(req.url);
  const since = url.searchParams.get("since")
    ? parseInt(url.searchParams.get("since")!)
    : undefined;
  const limit = url.searchParams.get("limit")
    ? parseInt(url.searchParams.get("limit")!)
    : undefined;

  const result = await getBroker().broker.changes(ctx, { since, limit });

  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
