export interface BrokerContext {
  userId: string;
  orgId: string; // from token/persona or session, never from request body — see docs/architecture.md
  env: "dev" | "live"; // from token/persona, never from request body
  allowedCollections?: string[] | null; // collection ceiling; null = no limit (carry on context from client policy)
  via: string; // 'session' | 'oauth' | 'token_exchange' | 'api_key:<id>' — audit trail of which credential authenticated this
}

export type DocumentFilter = { field: string; op: "eq" | "in"; value: unknown };
export type Document = Record<string, unknown>;

export type FilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "like" | "in";
export type Filter = { field: string; op: FilterOp; value: unknown };

export type Aggregate = { fn: "avg" | "sum" | "count" | "min" | "max"; field: string };

export type QueryIntent = {
  collection: string;
  fields?: string[];
  filters?: Filter[];
  orderBy?: { field: string; dir: "asc" | "desc" };
  limit?: number;   // hard-capped server-side (default 100, max 500)
  offset?: number;
  aggregate?: Aggregate[]; // when present, `fields` must be omitted
  groupBy?: string[];
};

export type DocSearchIntent = {
  collection: string;
  q: string;
  fields?: string[];
  limit?: number;
  offset?: number;
};

export type GetDocumentIntent =
  | { collection: string; id: string }
  | { collection: string; path: string };

export type RefusalReason =
  | "no_grant" | "expired_grant" | "field_denied"
  | "unknown_collection" | "unknown_field" | "invalid_intent" | "internal_error" | "not_found";

export type BrokerResult =
  | { ok: true; documents: Document[]; fieldsReturned: string[]; auditId: string }
  | { ok: false; reason: RefusalReason; auditId: string };

export type GetDocumentResult =
  | { ok: true; document: Document; fieldsReturned: string[]; rev?: string; auditId: string }
  | { ok: false; reason: RefusalReason; auditId: string };

export type MutationIntent =
  | { collection: string; op: "create"; values: Record<string, unknown> }
  | { collection: string; op: "update"; id: string; expect?: string; values: Record<string, unknown> }
  | { collection: string; op: "delete"; id: string; expect?: string };

export type MutationRefusalReason =
  | RefusalReason
  | "verb_denied" | "verb_not_supported" | "field_not_writable"
  | "conflict" | "invalid_value" | "not_writable"
  // Distinct from verb_denied on purpose: the caller does hold the approve verb, so telling them
  // "denied" would send them asking for a grant they already have. What they need is a second
  // person. See approveProposal.
  | "self_approval_denied";

export type MutationResult =
  | { ok: true; status: "applied"; documentId: string; rev: string; auditId: string }
  | { ok: true; status: "pending"; proposalId: string; auditId: string }
  | { ok: false; reason: MutationRefusalReason; auditId: string };

export type VisibleField = { name: string; type: string; pk?: boolean };
export type VisibleSchema = { collection: string; description: string; fields: VisibleField[] };
export type Refusal = { ok: false; reason: RefusalReason; auditId: string };

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
