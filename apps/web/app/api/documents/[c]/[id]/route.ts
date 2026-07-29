import type { NextRequest } from "next/server";
import type { GetDocumentIntent } from "@warehousd/broker";
import { deriveContext } from "../../../../../lib/session";
import { getBroker } from "../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../lib/rest";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> }
) {
  const ctx = await deriveContext(req);
  if (!ctx) return unauthenticated();

  const { c, id } = await params;
  const intent: GetDocumentIntent = { collection: c, id };

  const result = await getBroker().broker.getDocument(ctx, intent);
  if (!result.ok) return refuse(result.reason);

  return ok(result);
}
