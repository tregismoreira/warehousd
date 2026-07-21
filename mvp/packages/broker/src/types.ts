export interface BrokerContext {
  userId: string;
  env: "dev" | "live"; // from token/persona, never from request body
}

export type RowFilter = { field: string; op: "eq" | "in"; value: unknown };

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

export type RefusalReason =
  | "no_grant" | "expired_grant" | "field_denied"
  | "unknown_collection" | "unknown_field" | "invalid_intent";

export type BrokerResult =
  | { ok: true; rows: Record<string, unknown>[]; fieldsReturned: string[]; auditId: string }
  | { ok: false; reason: RefusalReason; auditId: string };

export type VisibleField = { name: string; type: string; pk?: boolean };
export type VisibleSchema = { collection: string; description: string; fields: VisibleField[] };
export type Refusal = { ok: false; reason: RefusalReason; auditId: string };

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
