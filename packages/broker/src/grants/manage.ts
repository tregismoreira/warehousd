import type { Pool } from "pg";
import type { DocumentFilter } from "../types";
import type { WarehousdConfig } from "../config/schema";
import {
  findCollection,
  grantableFields,
  writableFields,
  unmaskableFields,
  supportedVerbs,
} from "../config/load";
import { DEFAULT_ORG_ID } from "../db/migrate-app";
import { validateGrantFilters } from "./filters";

export type GrantRequestError =
  "unknown_collection" | "purpose_required" | "field_not_grantable" | "invalid_filter";

export const GRANT_VERBS = ["read", "create", "update", "delete", "approve"] as const;
export type GrantVerb = (typeof GRANT_VERBS)[number];
const MUTATING_VERBS: readonly string[] = ["create", "update", "delete"];

// One rule set for verbs, shared by every approval path — the web route, the MCP tool, and
// anything later. A rule enforced in only one of them is not a rule.
export function validateVerbs(
  verbs: string[],
  cfg: WarehousdConfig,
  collection: string,
  allowedFields: string[],
): { ok: true } | { ok: false; error: string } {
  if (verbs.length === 0) return { ok: false, error: "grant must carry at least one verb" };
  for (const v of verbs)
    if (!(GRANT_VERBS as readonly string[]).includes(v))
      return { ok: false, error: `unknown verb "${v}"` };

  if (!findCollection(cfg, collection)) return { ok: false, error: "unknown collection" };

  // Invariant: approve requires read. You cannot approve what you cannot see — without this,
  // "approve, then read the diff" is a privilege-escalation path around field postures.
  // Read is NOT required in general: an append-only ingestion grant (create, no read) is a
  // legitimate shape and forcing read on it would widen access, not narrow it.
  if (verbs.includes("approve") && !verbs.includes("read"))
    return { ok: false, error: "the approve verb requires read" };

  // Verb support is structural — it follows from the collection's type, so `update` on a file
  // collection is refused here regardless of what an approver asks for.
  const supported = supportedVerbs(cfg, collection);
  for (const v of verbs)
    if (MUTATING_VERBS.includes(v) && !supported.includes(v as "create" | "update" | "delete"))
      return { ok: false, error: `collection does not support the ${v} verb` };

  // A write verb over a field set containing nothing writable is a grant that can do nothing —
  // more likely a mistake than an intent, and silently approving it hides the mistake.
  if (verbs.some((v) => MUTATING_VERBS.includes(v))) {
    const writable = writableFields(cfg, collection);
    if (!allowedFields.some((f) => writable.includes(f)))
      return {
        ok: false,
        error: "write verbs require at least one writable field in allowed_fields",
      };
  }

  return { ok: true };
}

// Validation lives here, not in the callers: the web route and the MCP request_access
// tool both reach app.grants, and a rule enforced in only one of them is not a rule.
export function validateGrantRequest(
  cfg: WarehousdConfig,
  collection: string,
  purposeLabel: unknown,
  fields: unknown,
  // Filters a requester asked to be scoped by. No request surface offers them today — the
  // approver picks the values and the server picks the column (apps/web/lib/approve.ts) — but the
  // rule that a stored predicate must be evaluable belongs to this function rather than to
  // whichever surface grows the field first.
  documentFilters?: DocumentFilter[],
): { ok: true; fields: string[] } | { ok: false; error: GrantRequestError } {
  // Check collection exists
  const c = findCollection(cfg, collection);
  if (!c) return { ok: false, error: "unknown_collection" };

  // Check purpose is a non-empty trimmed string
  if (typeof purposeLabel !== "string" || !purposeLabel.trim())
    return { ok: false, error: "purpose_required" };

  // Get grantable fields for this collection
  const grantable = grantableFields(cfg, collection);

  // Default to all grantable fields if not specified, otherwise use provided fields
  const requested: string[] = Array.isArray(fields) && fields.length ? fields : grantable;

  // Validate all requested fields are grantable (posture:allow)
  for (const f of requested)
    if (!grantable.includes(f)) return { ok: false, error: "field_not_grantable" };

  // A predicate the two evaluators cannot agree on is refused now, not on the grant's first call.
  if (documentFilters?.length && validateGrantFilters(documentFilters, c))
    return { ok: false, error: "invalid_filter" };

  return { ok: true, fields: requested };
}

// orgId is optional so a single-org deployment — every deployment that existed before the
// org dimension — keeps working: an omitted org lands in the implicit one rather than
// failing the insert. Every real call site passes ctx.orgId.
export async function requestGrant(
  app: Pool,
  i: {
    userId: string;
    collection: string;
    env: "dev" | "live";
    orgId?: string | undefined;
    purposeLabel: string;
    purposeDetail?: string | undefined;
    allowedFields: string[];
  },
): Promise<string> {
  const r = await app.query(
    `insert into app.grants (user_id,collection,env,org_id,purpose_label,purpose_detail,allowed_fields,status)
     values ($1,$2,$3,$4,$5,$6,$7,'pending') returning id`,
    [
      i.userId,
      i.collection,
      i.env,
      i.orgId ?? DEFAULT_ORG_ID,
      i.purposeLabel,
      i.purposeDetail ?? null,
      i.allowedFields,
    ],
  );
  return r.rows[0].id;
}

export type ApproveGrantError =
  | "unknown_grant"
  | "invalid_verbs"
  | "invalid_unmask"
  | "invalid_filter"
  | "field_not_grantable"
  | "self_approval_denied";

// Every decision is scoped to the grant's org as well as its id. A grant id is a uuid, so
// this is a backstop rather than the primary gate — but it is the difference between a
// cross-tenant decision being impossible and being merely unlikely. An omitted orgId scopes
// to the implicit org, which fails to find a foreign grant rather than finding one: the
// forgetful path is closed, not open.
//
// cfg is required, not optional. Verb rules are only rules if every approval runs them, and
// an optional config parameter is an opt-out of the approve-requires-read invariant that a
// caller can take by accident.
export async function approveGrant(
  app: Pool,
  cfg: WarehousdConfig,
  id: string,
  by: string,
  opts: {
    allowedFields?: string[];
    expiresAt?: string;
    documentFilters?: DocumentFilter[];
    verbs?: string[];
    mode?: "direct" | "proposal_only";
    // Fields whose RAW value this grant carries. Every entry must be in allowedFields AND be
    // declared `unmask: allow` in the config — a manager can only widen a mask the YAML offered
    // to widen, which is what keeps the posture the ceiling rather than the starting point.
    unmaskedFields?: string[];
    orgId?: string;
  } = {},
): Promise<{ ok: true } | { ok: false; error: ApproveGrantError; detail?: string }> {
  const orgId = opts.orgId ?? DEFAULT_ORG_ID;
  const grantRes = await app.query(
    `select collection, allowed_fields, verbs, mode, user_id, env from app.grants
     where id=$1 and org_id=$2`,
    [id, orgId],
  );
  if (grantRes.rowCount === 0) return { ok: false, error: "unknown_grant" };
  const grant = grantRes.rows[0];

  // Segregation of duties, on the environment where it buys something. An approver who is also
  // the requester is the only party in the decision, and on `live` the thing being decided is
  // access to real data — so the second person has to be a second person. This mirrors
  // approveProposal's four-eyes rule (verbs/propose.ts), down to the reason code.
  //
  // `dev` is deliberately exempt. Its contents are generateSynthetic output, regenerable from
  // the console, and requiring a colleague to unlock fabricated rows teaches people to route
  // around the rule rather than to respect it.
  if (grant.env === "live" && grant.user_id === by)
    return { ok: false, error: "self_approval_denied" };

  const collection = grant.collection;
  const allowedFields = opts.allowedFields ?? grant.allowed_fields ?? [];
  const verbs = opts.verbs ?? grant.verbs ?? ["read"];
  const mode = opts.mode ?? grant.mode ?? "direct";

  const v = validateVerbs(verbs, cfg, collection, allowedFields);
  if (!v.ok) return { ok: false, error: "invalid_verbs", detail: v.error };

  // The two-tier deny, re-checked on the decision side. validateGrantRequest enforces it when a
  // grant is asked for, and the console's buildApproval derives the approver's field set from the
  // YAML — but both are caller-side guarantees, and the broker is the trust boundary. Without
  // this, an adapter calling approveGrant directly can store a field the config never made
  // grantable; since the unmask rules below take allowedFields as their base set, such a field
  // would also become an admissible unmask target.
  const grantable = grantableFields(cfg, collection);
  const notGrantable = allowedFields.filter((f: string) => !grantable.includes(f));
  if (notGrantable.length)
    return { ok: false, error: "field_not_grantable", detail: notGrantable.join(", ") };

  // A malformed predicate is refused while an approver is still present to be told about it,
  // rather than surfacing as `invalid_intent` on the grant's first call. The use-time check stays:
  // config can change between approval and use.
  const documentFilters = opts.documentFilters ?? [];
  if (documentFilters.length) {
    const c = findCollection(cfg, collection);
    // validateVerbs already refused an unknown collection, so c is non-null here.
    const bad = c ? validateGrantFilters(documentFilters, c) : null;
    if (bad) return { ok: false, error: "invalid_filter", detail: `${bad.field}: ${bad.detail}` };
  }

  const unmaskedFields = opts.unmaskedFields ?? [];
  if (unmaskedFields.length) {
    const unmaskable = new Set(unmaskableFields(cfg, collection));
    const notGranted = unmaskedFields.filter((f) => !allowedFields.includes(f));
    if (notGranted.length)
      return {
        ok: false,
        error: "invalid_unmask",
        detail: `not in allowed_fields: ${notGranted.join(", ")}`,
      };
    // A field that is not masked at all, or is masked with `unmask: deny`, cannot be unmasked
    // by any grant. Refused rather than ignored: silently dropping it would tell the approver
    // they granted something they did not.
    const notUnmaskable = unmaskedFields.filter((f) => !unmaskable.has(f));
    if (notUnmaskable.length)
      return {
        ok: false,
        error: "invalid_unmask",
        detail: `not declared unmask: allow: ${notUnmaskable.join(", ")}`,
      };
  }

  const result = await app.query(
    `update app.grants set status='approved', decided_by=$2, decided_at=now(),
       allowed_fields=coalesce($3, allowed_fields), expires_at=$4, document_filter=$5,
       verbs=$6, mode=$7, unmasked_fields=$9
     where id=$1 and org_id=$8 and status='pending'`,
    [
      id,
      by,
      opts.allowedFields ?? null,
      opts.expiresAt ?? null,
      opts.documentFilters && opts.documentFilters.length
        ? JSON.stringify(opts.documentFilters)
        : null,
      verbs,
      mode,
      orgId,
      unmaskedFields,
    ],
  );
  // Zero rows means the grant was not pending — already decided, or raced.
  return (result.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, error: "unknown_grant" };
}

export async function denyGrant(
  app: Pool,
  id: string,
  by: string,
  orgId = DEFAULT_ORG_ID,
): Promise<boolean> {
  const result = await app.query(
    `update app.grants set status='denied', decided_by=$2, decided_at=now()
    where id=$1 and org_id=$3 and status='pending'`,
    [id, by, orgId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeGrant(
  app: Pool,
  id: string,
  by: string,
  orgId = DEFAULT_ORG_ID,
): Promise<boolean> {
  const result = await app.query(
    `update app.grants set status='revoked', decided_by=$2, decided_at=now()
    where id=$1 and org_id=$3 and status='approved'`,
    [id, by, orgId],
  );
  return (result.rowCount ?? 0) > 0;
}
