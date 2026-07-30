import type { NextRequest } from "next/server";
import type { DocSearchIntent } from "@warehousd/broker";
import { deriveRestContext } from "../../../../../lib/rest-context";
import { getBroker } from "../../../../lib/broker";
import { unauthenticated, refuse, ok } from "../../../../../lib/rest";

export async function GET(req: NextRequest, { params }: { params: Promise<{ c: string }> }) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c } = await params;
  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";
  const limit = url.searchParams.get("limit")
    ? parseInt(url.searchParams.get("limit")!)
    : undefined;
  const offset = url.searchParams.get("offset")
    ? parseInt(url.searchParams.get("offset")!)
    : undefined;
  const fields = url.searchParams.getAll("fields");

  const intent: DocSearchIntent = {
    collection: c,
    q,
    fields: fields.length > 0 ? fields : undefined,
    limit,
    offset,
  };

  const result = await getBroker().broker.searchDocuments(ctx, intent);
  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
