import type { RefusalReason, MutationRefusalReason, AclRefusalReason } from "@warehousd/broker";

// Every reason any broker verb can refuse with, in one union, so `restStatus` stays the single
// table. A reason missing from here is a reason that would fall through to 500.
type AnyRefusalReason = RefusalReason | MutationRefusalReason | AclRefusalReason;

// Status-code table: maps broker refusal reasons to HTTP status codes.
// All routes use this single table so no route invents its own.
// conflict is special-cased: 412 if If-Match was provided (optimistic concurrency
// mismatch), 409 otherwise (unconditional conflict, e.g., duplicate key).
export function restStatus(reason: AnyRefusalReason, ifMatchProvided: boolean = false): number {
  if (reason === "conflict") return ifMatchProvided ? 412 : 409;

  // The batch did not commit — some proposal in it refused, and the whole transaction rolled
  // back. Not the caller's malformed request (400) and not a lock the caller holds (403): the
  // batch may simply be retried once the named failure (`failedProposalId`) is resolved.
  if (reason === "batch_aborted") return 409;

  // Access denial: no grant, expired grant, field/verb denial, field not writable
  if (
    reason === "no_grant" ||
    reason === "expired_grant" ||
    reason === "field_denied" ||
    reason === "verb_denied"
  )
    return 403;

  // Forbidden rather than conflict: the request is well-formed and the state is fine, it is the
  // caller who may not be the one to do this. No retry and no If-Match will change it — only a
  // different person will.
  if (reason === "self_approval_denied") return 403;

  // Managing an ACL is authorised against the caller's standing, not against a grant, so this is
  // the same family: well-formed request, wrong caller. Nothing they can retry changes it.
  if (reason === "acl_denied") return 403;

  // Extended table gap: field_not_writable is not in the plan's table because the plan
  // considered only query refusals initially. It maps to 403 (same family as field_denied:
  // both mean "you may see this exists but you may not act on it").
  if (reason === "field_not_writable") return 403;

  // Not found
  if (reason === "unknown_collection" || reason === "unknown_field" || reason === "not_found")
    return 404;

  // Client error: malformed intent or value
  if (reason === "invalid_intent" || reason === "invalid_value") return 400;

  // Method not allowed
  if (reason === "verb_not_supported" || reason === "not_writable") return 405;

  // Server error
  if (reason === "internal_error") return 500;

  return 500; // fallback
}

export function refuse(reason: AnyRefusalReason, ifMatchProvided?: boolean): Response {
  const status = restStatus(reason, ifMatchProvided);
  return Response.json({ error: reason }, { status });
}

// Unauthenticated is REST-adapter-level, not a broker refusal reason — it is fine to have
// this as a distinct path that doesn't go through restStatus.
export function unauthenticated(): Response {
  return Response.json({ error: "unauthenticated" }, { status: 401 });
}

export function ok<T>(data: T, status: number = 200): Response {
  return Response.json(data, { status });
}

// req.json() throws on an absent or non-JSON body, and a JSON array or scalar is not an intent
// either. Reporting that as invalid_intent keeps it inside the reason-code table instead of
// surfacing a parser error as a 500.
export async function readJson(
  req: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false };
    return { ok: true, value: body as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}
