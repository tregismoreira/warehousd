import type { NextRequest } from "next/server";
import { QueryIntentSchema } from "@warehousd/broker";
import { deriveRestContext } from "../../../../../lib/rest-context";
import { getBroker } from "../../../../lib/broker";
import { unauthenticated, refuse, ok, readJson } from "../../../../../lib/rest";

export async function POST(req: NextRequest, { params }: { params: Promise<{ c: string }> }) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const { c } = await params;

  // A malformed body is refused rather than defaulted. Treating it as an empty object would
  // answer 200 with every granted field — the caller sent nonsense and got a full result set,
  // which reads as though their filters were applied.
  const body = await readJson(req);
  if (!body.ok) return refuse("invalid_intent");

  // The collection comes from the path, never the body: two sources for one value is a question
  // about which wins, and the answer would have to be re-litigated at every call site.
  const parsed = QueryIntentSchema.safeParse({ ...body.value, collection: c });
  if (!parsed.success) return refuse("invalid_intent");

  const result = await getBroker().broker.query(ctx, parsed.data);
  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
