import type { NextRequest } from "next/server";
import type { QueryIntent } from "@warehousd/broker";
import { deriveRestContext } from "../../../../../lib/rest-context";
import { getBroker } from "../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../lib/rest";

export async function POST(req: NextRequest, { params }: { params: Promise<{ c: string }> }) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c } = await params;
  const body = await req.json();

  const intent: QueryIntent = {
    collection: c,
    fields: body.fields,
    filters: body.filters,
    orderBy: body.orderBy,
    limit: body.limit,
    offset: body.offset,
    aggregate: body.aggregate,
    groupBy: body.groupBy,
  };

  const result = await getBroker().broker.query(ctx, intent);
  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
