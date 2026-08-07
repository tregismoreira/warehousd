import type { AuditId, BrokerContext, RefusalReason } from "../types";
import type { CollectionConfig, MaskConfig } from "../config/schema";
import { findCollection, maskedFieldsFor } from "../config/load";
import { loadActiveGrant, type ActiveGrant } from "../grants/eval";
import { validateDocumentFilters } from "../grants/filters";
import type { AuditWriter, AuditDetail } from "../audit/decision";
import type { VerbDeps } from "./deps";

// The prologue every verb runs before it touches data, in one place.
//
// `query`, `searchDocuments` and `getDocument` each hand-wrote the same sequence —
// findCollection → loadActiveGrant → verb check → field check → document-filter check → mask plan
// → acl options — and `describeCollection`, `mutate` and `propose` wrote subsets of it. Repo-wide
// that was eight hand-written `verbs.includes("read")` tests. The duplication was a deliberate
// call when there were three verbs; it is the wrong one before adding a fourth and a fifth, and
// the codebase already makes exactly this argument in grants/eval.ts about the collection ceiling:
// "five call sites had already dropped it while still type-checking."
//
// Two rules here are security-relevant and are stated where they are enforced:
//
//   1. A missing `read` verb refuses `no_grant`, never `verb_denied`. A distinct code would tell a
//      caller that a grant exists which it cannot read with — the existence of the grant is itself
//      information. Only the WRITE verbs use `verb_denied`, where the caller already knows the
//      grant exists because they hold it.
//   2. `aclOpts` must be genuinely ABSENT on a collection without per-document ACLs, not present
//      and undefined. Under `exactOptionalPropertyTypes` those are different types, and buildSelect
//      reads the difference: a collection with no `_acl` column has nothing for the predicate to
//      compare against.

/** The verbs a grant can carry. `read` is the one that refuses as `no_grant`; the rest deny. */
export const GRANT_VERBS = ["read", "create", "update", "delete", "approve"] as const;
export type GrantVerb = (typeof GRANT_VERBS)[number];

/**
 * Rule 1 in the type system: `verb_denied` is not reachable on a read.
 *
 * `query` returns a `BrokerResult`, whose refusal arm is `RefusalReason` and does not include
 * `verb_denied`. Making the guard's return type depend on the verb is what lets the read verbs
 * keep that type without a cast — and what would make "unify these two codes" fail to compile
 * rather than merely be wrong.
 */
export type VerbRefusal<V extends GrantVerb> = V extends "read"
  ? RefusalReason
  : RefusalReason | "verb_denied";

/** The masking decision for one caller on one collection, computed once per verb. */
export type MaskPlan = {
  /** The fields this caller gets transformed. Checked against by the computed-use guard. */
  masked: Set<string>;
  /** What buildSelect calls per column. */
  maskFor: (field: string) => MaskConfig | null;
};

/** Everything a verb needs once the caller has been found to hold the collection. */
export type Granted = {
  collection: CollectionConfig;
  grant: ActiveGrant;
  plan: MaskPlan;
  aclOpts: { aclPrincipals?: string[] };
};

/**
 * Extra refusal reasons a caller's own `collectionCheck` may return, on top of the read verbs'
 * fixed set. `mutate` uses it for `not_writable` and `verb_not_supported`.
 */
export type GuardOptions<E extends string = never> = {
  /**
   * Structural questions about the collection that are answerable WITHOUT a grant, run between
   * `findCollection` and `loadActiveGrant`. Returning a reason refuses there.
   *
   * The position is the point: "this collection is not writable" is not a fact about the caller,
   * so making them prove a grant first would tell someone with no grant that the collection is
   * unwritable only after telling them they have no grant — two different answers to one question
   * depending on which they happen to lack.
   */
  collectionCheck?: ((c: CollectionConfig) => E | null) | undefined;
  /**
   * Fields the CLIENT named, checked against `grant.allowedFields` → `field_denied`. Checked here
   * rather than in each verb so it keeps its position in the sequence: today `query` and
   * `searchDocuments` both check it after the verb and before the document filters, and which
   * refusal wins when a request is wrong in two ways is observable.
   *
   * Not the same question as "does this field exist on the collection at all", which is
   * `unknown_field` and belongs to the verb — it is answerable without a grant, and answering it
   * after one would make a typo indistinguishable from a denial.
   */
  fields?: readonly string[] | undefined;
  /** Merged into every refusal this guard writes — `{ intent }`, where the verb has one. */
  detail?: AuditDetail | undefined;
  /**
   * Whether to check that the grant's document filters can be evaluated. On by default.
   *
   * `mutate` turns it off and keeps its own check, because it audits that refusal through
   * `refuseMutation` — a mutation's audit row records the op and the field NAMES it touched, and
   * routing it through the query-shaped writer would record `intent: null` for a write.
   */
  checkFilters?: boolean | undefined;
};

/**
 * Resolve the collection, the grant, the verb, the mask plan and the ACL options — or refuse.
 *
 * Every failure is already audited by the time it comes back, and the verb never sees a
 * half-resolved state: there is no arm of the return type carrying a collection but no grant.
 */
// Two overloads rather than one conditional return type. `VerbRefusal<V>` says the right thing but
// nothing can be assigned to it while `V` is still generic, so the implementation would have to
// cast at every return — which is the compiler being told to trust a claim, rather than the claim
// being checked. The `verb === "read"` branch below is where the rule actually lives.
export async function resolveGranted<E extends string = never>(
  d: VerbDeps,
  audit: AuditWriter,
  ctx: BrokerContext,
  collection: string,
  verb: "read",
  opts?: GuardOptions<E>,
): Promise<
  ({ ok: true } & Granted) | { ok: false; reason: VerbRefusal<"read"> | E; auditId: AuditId }
>;
export async function resolveGranted<E extends string = never>(
  d: VerbDeps,
  audit: AuditWriter,
  ctx: BrokerContext,
  collection: string,
  verb: GrantVerb,
  opts?: GuardOptions<E>,
): Promise<
  ({ ok: true } & Granted) | { ok: false; reason: VerbRefusal<GrantVerb> | E; auditId: AuditId }
>;
export async function resolveGranted<E extends string = never>(
  d: VerbDeps,
  audit: AuditWriter,
  ctx: BrokerContext,
  collection: string,
  verb: GrantVerb,
  opts: GuardOptions<E> = {},
): Promise<
  ({ ok: true } & Granted) | { ok: false; reason: VerbRefusal<GrantVerb> | E; auditId: AuditId }
> {
  const detail = opts.detail ?? {};

  const c = findCollection(d.cfg, collection);
  if (!c) return audit.refuse(collection, "unknown_collection", detail);

  const structural = opts.collectionCheck?.(c) ?? null;
  if (structural !== null) return audit.refuse(collection, structural, detail);

  const grant = await loadActiveGrant(d.app, ctx, collection);
  if (!grant) return audit.refuse(collection, "no_grant", detail);

  // Rule 1. `read` is absent from the grant → the collection is simply not readable by this
  // caller, which is `no_grant`. Do not unify these.
  if (!grant.verbs.includes(verb))
    return audit.refuse(collection, verb === "read" ? "no_grant" : "verb_denied", {
      ...detail,
      // A refusal reached before the grant was consulted carries no grant; this one was reached
      // BY consulting it, so the audit row names the authority it was decided under.
      ...(verb === "read" ? {} : { grant }),
    });

  for (const f of opts.fields ?? [])
    if (!grant.allowedFields.includes(f))
      return audit.refuse(collection, "field_denied", { ...detail, grant });

  // The grant's document filters are author-supplied, so each predicate's field is validated
  // against the collection's FULL field set rather than allowedFields — a denied field like a
  // file's `path` is exactly the sort of thing that gates documents. The same check runs on the
  // write path, so a filter this rejects is rejected everywhere rather than being evaluated by one
  // path and not the other. See grants/filters.ts.
  if (opts.checkFilters !== false && validateDocumentFilters(grant.documentFilter, c))
    return audit.refuse(collection, "invalid_intent", { ...detail, grant });

  return {
    ok: true,
    collection: c,
    grant,
    plan: maskPlan(d.cfg, collection, c, grant.unmaskedFields),
    ...{ aclOpts: aclOpts(c, grant) },
  };
}

// The per-document ACL half of a read, as the option bag buildSelect takes.
//
// Spread rather than passed as a nullable key: under `exactOptionalPropertyTypes` an explicit
// `aclPrincipals: undefined` is not the same as an absent one, and the difference matters — a
// collection without ACLs has no `_acl` column for the predicate to compare, so the option must be
// genuinely absent rather than present and empty.
export function aclOpts(
  c: CollectionConfig,
  grant: { principals: string[] },
): { aclPrincipals?: string[] } {
  return c.acl ? { aclPrincipals: grant.principals } : {};
}

// `maskFor` is what buildSelect calls per column; `masked` is the set the computed-use guard checks
// against. Both come from the same maskedFieldsFor() so the two questions — "is this transformed?"
// and "may this be filtered on?" — can never be answered inconsistently.
export function maskPlan(
  cfg: Parameters<typeof maskedFieldsFor>[0],
  collection: string,
  c: CollectionConfig,
  unmasked: readonly string[],
): MaskPlan {
  const masked = new Set(maskedFieldsFor(cfg, collection, unmasked));
  return {
    masked,
    maskFor: (field) => (masked.has(field) ? (c.fields[field]?.mask ?? null) : null),
  };
}
