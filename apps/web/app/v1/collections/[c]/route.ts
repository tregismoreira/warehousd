import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../../lib/rest-context";
import { getBroker } from "../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../lib/rest";

export async function GET(req: NextRequest, { params }: { params: Promise<{ c: string }> }) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c } = await params;
  const result = await getBroker().broker.describeCollection(ctx, c);

  if ("ok" in result && !result.ok) return refuse(result.reason);
  return ok(result);
}
