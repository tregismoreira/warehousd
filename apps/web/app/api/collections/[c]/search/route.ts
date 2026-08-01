import type { NextRequest } from "next/server";
import { DocSearchIntentSchema } from "@warehousd/broker";
import { deriveContext } from "../../../../../lib/session";
import { getBroker } from "../../../../lib/broker";
import { unauthenticated, restStatus } from "../../../../../lib/rest";

// Full-text search over a file collection, from the console session. The token-authenticated
// twin is `/v1/collections/[c]/search`; see the query route beside this one for why the console
// gets its own adapter rather than a role gate on that one.
export async function GET(req: NextRequest, { params }: { params: Promise<{ c: string }> }) {
  const ctx = await deriveContext(req);
  if (!ctx) return unauthenticated();

  const { c } = await params;
  const url = new URL(req.url);
  const fields = url.searchParams.getAll("fields");

  // Parsed rather than assembled. A query string carries only strings, so `limit=abc` reaches
  // the broker as NaN unless something rejects it first — and the broker answers that with
  // invalid_intent from further away, after a grant lookup it need not have paid for.
  const parsed = DocSearchIntentSchema.safeParse({
    collection: c,
    q: url.searchParams.get("q") ?? "",
    fields: fields.length ? fields : undefined,
    limit: numeric(url.searchParams.get("limit")),
    offset: numeric(url.searchParams.get("offset")),
  });
  if (!parsed.success)
    return Response.json(
      { ok: false, reason: "invalid_intent", auditId: null },
      { status: restStatus("invalid_intent") },
    );

  const result = await getBroker().broker.searchDocuments(ctx, parsed.data);
  return Response.json(result, { status: result.ok ? 200 : restStatus(result.reason) });
}

// An absent parameter is undefined, not 0 — the schema's `.optional()` is what lets the broker
// apply its own default. A present but unparseable one stays a string, so the schema refuses it
// instead of silently becoming NaN.
function numeric(raw: string | null): number | string | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}
