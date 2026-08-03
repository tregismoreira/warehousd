export interface BrokerContext {
  userId: string;
  orgId: string; // from token/persona or session, never from request body — see docs/architecture.md
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

export type DocSearchIntent = {
  collection: string;
  q: string;
  fields?: string[] | undefined;
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

// `auditId` is null on exactly one path: the audit insert itself failed. It is never null on a
// successful result — an allow whose decision could not be recorded is downgraded to an
// `internal_error` refusal before it reaches a caller. See audit/decision.ts.
export type AuditId = string | null;

export type BrokerResult =
  | {
      ok: true;
      documents: Document[];
      fieldsReturned: string[];
      auditId: string;
    }
  | { ok: false; reason: RefusalReason; auditId: AuditId };

export type GetDocumentResult =
  | {
      ok: true;
      document: Document;
      fieldsReturned: string[];
      rev?: string | undefined;
      auditId: string;
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
      auditId: string;
    }
  | { ok: true; status: "pending"; proposalId: string; auditId: string }
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
