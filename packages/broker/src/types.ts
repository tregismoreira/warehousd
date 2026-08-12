export interface BrokerContext {
  userId: string;
  workspaceId: string; // from token/persona or session, never from request body — see docs/architecture.md
  env: "dev" | "live"; // from token/persona, never from request body
  // Collection ceiling; null = no limit (carried on the context from the client policy).
  //
  // Required, not optional. The `?` was what let five call sites drop it while still
  // type-checking — a context built without it is a context with no ceiling, which is the widest
  // possible answer arrived at by omission rather than by decision. `null` still says "no
  // ceiling"; it just has to be said.
  allowedCollections: string[] | null;
  via: string; // 'session' | 'oauth' | 'token_exchange' | 'api_key:<id>' — audit trail of which credential authenticated this
}

export type DocumentFilter = { field: string; op: "eq" | "in"; value: unknown };
export type Document = Record<string, unknown>;

export type FilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "like" | "in";
export type Filter = { field: string; op: FilterOp; value: unknown };

export type Aggregate = {
  fn: "avg" | "sum" | "count" | "min" | "max";
  field: string;
};

// The four intent types spell their optional members `?: T | undefined` rather than `?: T`.
// Under `exactOptionalPropertyTypes` those are different: the first admits a key that is present
// and holds `undefined`, the second only a key that is absent. Every value of these types comes
// out of `intents/schema.ts`, and a zod `.optional()` produces the *former* — so writing `?: T`
// here claimed something about client-supplied JSON that neither `JSON.parse` nor the schema
// guarantees. See intents/schema.ts for why these shapes are declared twice at all.
export type QueryIntent = {
  collection: string;
  fields?: string[] | undefined;
  filters?: Filter[] | undefined;
  orderBy?: { field: string; dir: "asc" | "desc" } | undefined;
  limit?: number | undefined; // hard-capped server-side (default 100, max 500)
  offset?: number | undefined;
  aggregate?: Aggregate[] | undefined; // when present, `fields` must be omitted
  groupBy?: string[] | undefined;
};

export type SearchMode = "text" | "semantic" | "hybrid";

export type DocSearchIntent = {
  // Absent means "every collection this caller holds a read grant on". A required collection made
  // search unusable for the question people actually ask: someone asking Claude "what's our
  // parental leave policy" has to already know it lives in `policies`.
  collection?: string | undefined;
  q: string;
  fields?: string[] | undefined;
  // Absent means "text", which is what every caller written before semantic search sends.
  mode?: SearchMode | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export type GetDocumentIntent =
  { collection: string; id: string } | { collection: string; path: string };

export type RefusalReason =
  | "no_grant"
  | "expired_grant"
  | "field_denied"
  | "unknown_collection"
  | "unknown_field"
  | "invalid_intent"
  | "internal_error"
  | "not_found";

// `auditId` is null on exactly two paths, and a caller can tell them apart without inspecting it.
// On a *refusal* it means the audit insert itself failed; the refusal stands regardless, because
// there is nothing to withhold. On a *success* it means this deployment runs with
// `audit.enabled: false` and no row was ever going to be written. An allow whose decision could
// not be recorded is never one of these: it is downgraded to an `internal_error` refusal before it
// reaches a caller. See audit/decision.ts.
export type AuditId = string | null;

export type BrokerResult =
  | {
      ok: true;
      documents: Document[];
      fieldsReturned: string[];
      auditId: AuditId;
      // Present only on a fan-out search: which collections were reached, and which refused.
      // A single-collection call is byte-identical to what it always was.
      collections?: SearchedCollection[] | undefined;
    }
  | { ok: false; reason: RefusalReason; auditId: AuditId };

/**
 * One row of the catalogue, as `list_collections` returns it.
 *
 * `access` is about the CALLER and nobody else: "granted" means this caller holds a read grant,
 * "none" means it does not. Against twenty collections it is the difference between a model
 * finding its three immediately and burning twenty describe calls to find them.
 */
export type CollectionListing = {
  name: string;
  description: string;
  access: "granted" | "none";
  /** How many of the collection's fields the grant carries. Absent when access is "none". */
  grantedFields?: number | undefined;
};

/** One collection's part in a fan-out search. A refusal is reported, never silently dropped. */
export type SearchedCollection = {
  collection: string;
  matched: number;
  reason: RefusalReason | null;
  auditId: AuditId;
};

export type GetDocumentResult =
  | {
      ok: true;
      document: Document;
      fieldsReturned: string[];
      rev?: string | undefined;
      auditId: AuditId;
    }
  | { ok: false; reason: RefusalReason; auditId: AuditId };

export type MutationIntent =
  | { collection: string; op: "create"; values: Record<string, unknown> }
  | {
      collection: string;
      op: "update";
      id: string;
      expect?: string | undefined;
      values: Record<string, unknown>;
    }
  | { collection: string; op: "delete"; id: string; expect?: string | undefined };

export type MutationRefusalReason =
  | RefusalReason
  | "verb_denied"
  | "verb_not_supported"
  | "field_not_writable"
  | "conflict"
  | "invalid_value"
  | "not_writable"
  // Distinct from verb_denied on purpose: the caller does hold the approve verb, so telling them
  // "denied" would send them asking for a grant they already have. What they need is a second
  // person. See approveProposal.
  | "self_approval_denied";

export type MutationResult =
  | {
      ok: true;
      status: "applied";
      documentId: string;
      rev: string;
      auditId: AuditId;
    }
  | { ok: true; status: "pending"; proposalId: string; auditId: AuditId }
  | { ok: false; reason: MutationRefusalReason; auditId: AuditId };

// `masked` is present only when true, so an unmasked schema is byte-identical to what it was
// before masking existed. A masked field is readable but transformed, and cannot be filtered,
// ordered, grouped or aggregated on — see collectComputed in verbs/read.ts.
export type VisibleField = {
  name: string;
  type: string;
  pk?: boolean | undefined;
  masked?: true | undefined;
};
export type VisibleSchema = {
  collection: string;
  description: string;
  fields: VisibleField[];
};
export type Refusal = { ok: false; reason: RefusalReason; auditId: AuditId };
export type MutationRefusal = {
  ok: false;
  reason: MutationRefusalReason;
  auditId: AuditId;
};

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
