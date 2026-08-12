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
import { isPrincipal, userPrincipal, GROUP_PREFIX, USER_PREFIX } from "../acl/principals";
import { validateGrantFilters } from "./filters";

export const GRANT_REQUEST_ERRORS = [
  "unknown_collection",
  "purpose_required",
  "field_not_grantable",
  "invalid_principal",
] as const;
export type GrantRequestError = (typeof GRANT_REQUEST_ERRORS)[number];

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

  // No filter check here, on purpose. A grant request carries no predicates — the approver picks
  // the values and the server picks the column (apps/web/lib/approve.ts) — so approveGrant is the
  // only path that ever writes a document filter, and that is where the rule lives. A parameter
  // here would be an unexercised second copy of it, which is how the two drift.
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
    /**
     * WHO the grant is for — `user:<id>` or `group:<name>`. Defaults to the requester, which is
     * every grant that existed before groups could hold one.
     *
     * `userId` stays what it always was: who ASKED. On a group grant the two differ, and both are
     * needed — the manager inbox shows the requester, the loader matches the principal.
     */
    principal?: string | undefined;
  },
): Promise<string> {
  const principal = i.principal ?? userPrincipal(i.userId);
  // Namespaced or refused. A bare `legal` is ambiguous between a user id and a group name, and
  // guessing which an approver meant is how a grant widens by accident — the same rule
  // acl/manage.ts already applies to an ACL entry.
  // Read back off the input rather than the narrowed local: `isPrincipal` is a type guard, so in
  // the false branch the local has narrowed to `never` and cannot be interpolated.
  if (!isPrincipal(principal))
    throw new Error(
      `invalid grant principal "${i.principal ?? ""}" — spell it user:<id> or group:<name>`,
    );
  const r = await app.query(
    `insert into app.grants (user_id,collection,env,org_id,purpose_label,purpose_detail,allowed_fields,principal,status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'pending') returning id`,
    [
      i.userId,
      i.collection,
      i.env,
      i.orgId ?? DEFAULT_ORG_ID,
      i.purposeLabel,
      i.purposeDetail ?? null,
      i.allowedFields,
      principal,
    ],
  );
  return r.rows[0].id;
}

/**
 * Would approving this grant NARROW what its subject can already do?
 *
 * The honest cost of specificity ordering: a personal grant narrower than the group grant the
 * user inherits *reduces* their access, because `user:` wins. That surprises people, so approval
 * warns — it does not refuse. Refusing would make the narrower personal grant, which is exactly
 * the purpose-bound decision the product is for, impossible to express.
 *
 * Returns the fields the subject would lose, and the group grant they would lose them from.
 */
export async function narrowerThanInherited(
  app: Pool,
  i: {
    userId: string;
    collection: string;
    env: "dev" | "live";
    orgId?: string | undefined;
    principal: string;
    allowedFields: string[];
  },
): Promise<{ principal: string; losing: string[] } | null> {
  // Only a PERSONAL grant can shadow anything: a group grant loses to a personal one, so it never
  // takes access away.
  if (!i.principal.startsWith(USER_PREFIX)) return null;

  const groups = await app.query<{ principal: string; allowed_fields: string[] | null }>(
    `select principal, allowed_fields from app.grants
     where collection=$1 and env=$2 and org_id=$3 and status='approved'
       and (expires_at is null or expires_at > now())
       and principal like $4
       and principal in (
         select $5 || group_name from app.user_groups where org_id=$3 and user_id=$6
       )
     order by requested_at desc limit 1`,
    [i.collection, i.env, i.orgId ?? DEFAULT_ORG_ID, `${GROUP_PREFIX}%`, GROUP_PREFIX, i.userId],
  );
  const inherited = groups.rows[0];
  if (!inherited) return null;
  const losing = (inherited.allowed_fields ?? []).filter((f) => !i.allowedFields.includes(f));
  return losing.length ? { principal: inherited.principal, losing } : null;
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
): Promise<
  | { ok: true; warning?: { principal: string; losing: string[] } }
  | { ok: false; error: ApproveGrantError; detail?: string }
> {
  const orgId = opts.orgId ?? DEFAULT_ORG_ID;
  const grantRes = await app.query(
    `select collection, allowed_fields, verbs, mode, user_id, env, principal from app.grants
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

  // The warning, computed before the write so the caller gets it alongside the outcome rather
  // than having to ask a second question afterwards. It never blocks — see narrowerThanInherited.
  const narrowing = await narrowerThanInherited(app, {
    userId: grant.user_id,
    collection,
    env: grant.env,
    orgId,
    principal: grant.principal ?? userPrincipal(grant.user_id),
    allowedFields,
  });

  const result = await app.query(
    `update app.grants set status='approved', decided_by=$2, decided_at=now(),
       allowed_fields=coalesce($3, allowed_fields), expires_at=$4, document_filter=$5,
       verbs=$6, mode=$7, unmasked_fields=$9
     where id=$1 and org_id=$8 and status='pending'`,
    [
      id,
      by,
      opts.allowedFields ?? null,
      resolveExpiry(cfg, collection, opts.expiresAt),
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
  if ((result.rowCount ?? 0) === 0) return { ok: false, error: "unknown_grant" };
  return narrowing ? { ok: true, warning: narrowing } : { ok: true };
}

/**
 * When an approved grant should lapse.
 *
 * An approver's own choice always wins — including "never", by passing an explicit value. What
 * this adds is the collection's default for the case that used to mean permanent: an approver who
 * named nothing. `expires_at` was enforced at query time and rendered in two tables, and that was
 * the whole of the lifecycle; access granted for a one-off purpose outlived the purpose unless
 * somebody remembered it.
 *
 * Null, still, where neither the approver nor the config names one — a public collection has no
 * reason to expire.
 */
export function resolveExpiry(
  cfg: WarehousdConfig,
  collection: string,
  explicit: string | undefined,
): string | null {
  if (explicit) return explicit;
  const days = cfg.collections[collection]?.grant_expiry_days;
  if (!days) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Grants that are approved, live, and about to lapse — the manager inbox's other half.
 *
 * `within` is a window in days. The point is not the list but its timing: renewing access before
 * it lapses is a decision somebody makes deliberately, and finding out because a query started
 * refusing is not.
 */
export async function expiringGrants(
  app: Pool,
  opts: { orgId?: string; within?: number } = {},
): Promise<
  {
    id: string;
    userId: string;
    collection: string;
    env: string;
    principal: string;
    expiresAt: string;
  }[]
> {
  const r = await app.query(
    `select id, user_id, collection, env, principal, expires_at from app.grants
     where org_id = $1 and status = 'approved'
       and expires_at is not null
       and expires_at > now()
       and expires_at < now() + ($2 || ' days')::interval
     order by expires_at asc`,
    [opts.orgId ?? DEFAULT_ORG_ID, String(opts.within ?? 7)],
  );
  return r.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    collection: row.collection,
    env: row.env,
    principal: row.principal,
    expiresAt: row.expires_at,
  }));
}

/**
 * Access recertification: every approved grant older than N days, with when it was last used.
 *
 * "Last used" comes from `app.audit_events` — the data was already there, and the grant id has
 * been on every audit row since audit/decision.ts started passing the grant rather than its id.
 * A grant nobody has exercised in ninety days is the easiest revoke a reviewer will ever make,
 * and until now there was no way to find one.
 *
 * Deliberately a QUERY and not a sweep. Expiring access automatically on a schedule would make the
 * console's answer depend on when a job last ran; this makes the state of the world legible and
 * leaves the decision with a person.
 */
export async function accessReview(
  app: Pool,
  opts: { orgId?: string; olderThanDays?: number } = {},
): Promise<
  {
    id: string;
    userId: string;
    collection: string;
    env: string;
    principal: string;
    allowedFields: string[];
    approvedAt: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    /** Decisions recorded under this grant. Zero is the interesting number. */
    uses: number;
  }[]
> {
  const r = await app.query(
    `select g.id, g.user_id, g.collection, g.env, g.principal, g.allowed_fields,
            g.decided_at, g.expires_at,
            max(a.at) as last_used_at,
            count(a.id)::int as uses
     from app.grants g
     left join app.audit_events a on a.grant_id = g.id
     where g.org_id = $1 and g.status = 'approved'
       and g.decided_at < now() - ($2 || ' days')::interval
     group by g.id
     order by last_used_at asc nulls first, g.decided_at asc`,
    [opts.orgId ?? DEFAULT_ORG_ID, String(opts.olderThanDays ?? 90)],
  );
  return r.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    collection: row.collection,
    env: row.env,
    principal: row.principal,
    allowedFields: row.allowed_fields ?? [],
    approvedAt: row.decided_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    uses: row.uses,
  }));
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
