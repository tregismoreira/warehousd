import type { RefusalReason, MutationRefusalReason } from "@warehousd/broker";

// Status-code table: maps broker refusal reasons to HTTP status codes.
// All routes use this single table so no route invents its own.
// conflict is special-cased: 412 if If-Match was provided (optimistic concurrency
// mismatch), 409 otherwise (unconditional conflict, e.g., duplicate key).
export function restStatus(
  reason: RefusalReason | MutationRefusalReason,
  ifMatchProvided: boolean = false,
): number {
  if (reason === "conflict") return ifMatchProvided ? 412 : 409;

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

export function refuse(
  reason: RefusalReason | MutationRefusalReason,
  ifMatchProvided?: boolean,
): Response {
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
