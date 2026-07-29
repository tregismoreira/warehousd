import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../../../lib/rest-context";
import { getBroker } from "../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../lib/rest";

export async function POST(req: NextRequest, { params }: { params: Promise<{ c: string }> }) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c } = await params;
  const body = await req.json();

  const intent = {
    collection: c,
    op: "create" as const,
    values: body,
  };

  const result = await getBroker().broker.mutate(ctx, intent);
  if (!result.ok) return refuse(result.reason);

  if (result.status === "applied") {
    const response = ok(result, 201);
    response.headers.set("Location", `/v1/collections/${c}/documents/${result.documentId}`);
    return response;
  } else {
    // pending
    return ok(result, 202);
  }
}
