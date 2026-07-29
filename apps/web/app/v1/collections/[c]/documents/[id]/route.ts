import type { NextRequest } from "next/server";
import type { GetDocumentIntent } from "@warehousd/broker";
import { deriveRestContext } from "../../../../../../lib/rest-context";
import { getBroker } from "../../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../../lib/rest";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> }
) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c, id } = await params;
  const intent: GetDocumentIntent = { collection: c, id };

  const result = await getBroker().broker.getDocument(ctx, intent);
  if (!result.ok) return refuse(result.reason);

  const response = ok(result);
  // RFC 7232: ETag value must be quoted. rev is the _rev uuid for writable dataset collections,
  // or content checksum for file collections. Only present on writable collections.
  if (result.rev) response.headers.set("ETag", `"${result.rev}"`);
  return response;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> }
) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c, id } = await params;
  const body = await req.json();
  const ifMatch = req.headers.get("If-Match");

  // Strip quotes from If-Match (RFC 7232 format: "value")
  const expect = ifMatch ? ifMatch.replace(/^"|"$/g, "") : undefined;

  const intent = {
    collection: c,
    op: "update" as const,
    id,
    expect,
    values: body,
  };

  const result = await getBroker().broker.mutate(ctx, intent);
  if (!result.ok) return refuse(result.reason, !!ifMatch);

  // conflict with If-Match → 412; conflict without → 409
  if (result.status === "applied") {
    const response = ok(result, 200);
    response.headers.set("ETag", `"${result.rev}"`);
    return response;
  } else {
    // pending
    return ok(result, 202);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> }
) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c, id } = await params;

  const intent = {
    collection: c,
    op: "delete" as const,
    id,
  };

  const result = await getBroker().broker.mutate(ctx, intent);
  if (!result.ok) return refuse(result.reason);

  if (result.status === "applied") {
    // RFC 7231 §6.3.5: 204 must not have a message body
    return new Response(null, { status: 204 });
  } else {
    // pending
    return ok(result, 202);
  }
}
