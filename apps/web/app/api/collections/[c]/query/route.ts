import type { NextRequest } from "next/server";
import { QueryIntentSchema } from "@warehousd/broker";
import { deriveContext } from "../../../../../lib/session";
import { getBroker } from "../../../../lib/broker";
import { unauthenticated, restStatus } from "../../../../../lib/rest";

// The console's read path. Session-authenticated where `/v1/collections/[c]/query` is
// token-authenticated, and identical in every other respect: same broker verb, same context
// rules, same audit row. Browsing from the console is governed, not privileged — an admin sees
// exactly what their own grants allow, and every page of results leaves a decision in the trail.
//
// Not role-gated on purpose. A role gate here would be a second, weaker access rule sitting in
// front of the real one; grants are the real one.
export async function POST(req: NextRequest, { params }: { params: Promise<{ c: string }> }) {
  const ctx = await deriveContext(req);
  if (!ctx) return unauthenticated();

  const { c } = await params;

  // A malformed body is refused rather than defaulted. Treating it as an empty object would
  // answer 200 with every granted field — the caller sent nonsense and got a full result set,
  // which reads as though their filters were applied.
  const body = await readJson(req);
  if (!body.ok) return refusal("invalid_intent");

  // The collection comes from the path, never the body: two sources for one value is a question
  // about which wins, and the answer would have to be re-litigated at every call site.
  const parsed = QueryIntentSchema.safeParse({ ...body.value, collection: c });
  if (!parsed.success) return refusal("invalid_intent");

  const result = await getBroker().broker.query(ctx, parsed.data);
  // The BrokerResult union, unchanged. `/v1` flattens a refusal to `{ error: reason }` because a
  // REST client wants a status code and a string; the console wants the reason itself, because
  // `no_grant` is not an error page there — it is the empty state that offers to request access.
  return Response.json(result, { status: result.ok ? 200 : restStatus(result.reason) });
}

function refusal(reason: "invalid_intent"): Response {
  return Response.json({ ok: false, reason, auditId: null }, { status: restStatus(reason) });
}

// req.json() throws on an absent or non-JSON body, and a JSON array or scalar is not an intent
// either. Reporting that as invalid_intent keeps it inside the reason-code table instead of
// surfacing a parser error as a 500.
async function readJson(
  req: NextRequest,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false };
    return { ok: true, value: body as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}
