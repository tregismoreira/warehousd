import type { Pool } from "pg";
import type { BrokerContext, DocumentFilter } from "../types";
import { SELF } from "./filters";
import { loadPrincipals } from "../acl/principals";

export type ActiveGrant = {
  id: string;
  allowedFields: string[];
  // Subset of allowedFields whose raw value this grant carries. Every other masked field comes
  // back transformed. Empty is the default and the safe answer.
  unmaskedFields: string[];
  documentFilter: DocumentFilter[];
  verbs: string[];
  mode: string;
  // Who the caller is, for per-document ACLs: `user:<id>` plus one `group:<name>` per membership
  // in `app.user_groups`. It rides on the grant rather than being fetched where it is used because
  // every verb already loads a grant — so no verb can forget principals, and there is no second
  // call site to drop. Exactly the argument this file makes above for putting the collection
  // ceiling on `ctx`.
  //
  // Never from a token or a claim: see acl/principals.ts.
  principals: string[];
};

// Loaded fresh on every broker call — grants are never baked into a token/cache.
//
// It takes the whole context rather than spread parameters on purpose. The collection ceiling
// lives here so that no broker verb can forget it, and a trailing optional argument is exactly
// how a caller forgets: five call sites had already dropped it while still type-checking.
// Passing `ctx` means adding a future dimension cannot silently skip any of them — and the field
// is now required on BrokerContext, so it cannot be dropped from the context either.
export async function loadActiveGrant(
  db: Pool,
  ctx: Pick<BrokerContext, "userId" | "orgId" | "env" | "allowedCollections">,
  collection: string,
): Promise<ActiveGrant | null> {
  const { userId, orgId, env, allowedCollections } = ctx;

  // The client's collection ceiling. It only ever narrows: a collection outside it returns null,
  // so every verb refuses `no_grant` uniformly. A distinguishable code would tell an app exactly
  // which collections it is missing.
  if (allowedCollections != null && !allowedCollections.includes(collection)) return null;

  const r = await db.query(
    `select id, allowed_fields, unmasked_fields, document_filter, verbs, mode from app.grants
     where user_id=$1 and collection=$2 and env=$3 and org_id=$4
       and status='approved' and (expires_at is null or expires_at > now())
     order by requested_at desc limit 1`,
    [userId, collection, env, orgId],
  );
  if (r.rowCount === 0) return null;
  // Loaded here, in the same call, for the same reason the grant itself is: it is fresh on every
  // broker call and never cached. Only once a grant exists — there is nothing to scope otherwise.
  const principals = await loadPrincipals(db, ctx);
  return toActiveGrant(r.rows[0], userId, principals);
}

// Same question as loadActiveGrant, asked about many collections at once. Two verbs
// (`changes`, `listProposals`) ask it for every configured collection, which was one round trip
// each. A collection with no active grant is absent from the map — exactly the null the
// single-collection loader returns, so neither caller has to learn a second convention.
export async function loadActiveGrants(
  db: Pool,
  ctx: Pick<BrokerContext, "userId" | "orgId" | "env" | "allowedCollections">,
  collections: string[],
): Promise<Map<string, ActiveGrant>> {
  const { userId, orgId, env, allowedCollections } = ctx;

  // The ceiling is applied to the input list rather than inside the query, so it stays the same
  // narrowing rule the single loader states above rather than a second copy of it in SQL.
  const asked =
    allowedCollections != null
      ? collections.filter((c) => allowedCollections.includes(c))
      : collections;
  const out = new Map<string, ActiveGrant>();
  if (asked.length === 0) return out;

  // `distinct on (collection)` with the same `requested_at desc` tie-break the single loader
  // uses, so a superseded grant loses to its replacement identically either way.
  const r = await db.query(
    `select distinct on (collection) collection, id, allowed_fields, unmasked_fields,
       document_filter, verbs, mode
     from app.grants
     where user_id=$1 and collection = any($2) and env=$3 and org_id=$4
       and status='approved' and (expires_at is null or expires_at > now())
     order by collection, requested_at desc`,
    [userId, asked, env, orgId],
  );

  if (r.rowCount === 0) return out;
  // One membership lookup for the whole batch: principals are a property of the caller, not of a
  // collection, so asking per grant would be the same answer N times.
  const principals = await loadPrincipals(db, ctx);
  for (const row of r.rows) out.set(row.collection, toActiveGrant(row, userId, principals));
  return out;
}

// The one place a grant row becomes an ActiveGrant. Both loaders go through it so the legacy
// document_filter check and the $self binding — the security-relevant parts — cannot drift apart.
function toActiveGrant(
  row: {
    id: string;
    allowed_fields: string[] | null;
    unmasked_fields: string[] | null;
    document_filter: unknown;
    verbs: string[] | null;
    mode: string | null;
  },
  userId: string,
  principals: string[],
): ActiveGrant {
  const df = row.document_filter;
  // document_filter is a DocumentFilter[]. A row holding the pre-Stage-2 object form is a
  // database that predates this schema and must be rebuilt — coercing it to [] would silently
  // widen a scoped grant to the whole collection, which is the one failure mode worth crashing on.
  if (df !== null && df !== undefined && !Array.isArray(df))
    throw new Error(`grant ${row.id}: document_filter is not an array (rebuild the database)`);

  // Resolve $self, per predicate and per element inside an `in` list. Binding happens here so
  // no caller can forget it and the SQL builder still sees a plain literal. Only the exact
  // string is a sentinel — "$self-service" is a literal, and there is no substring interpolation.
  const documentFilter: DocumentFilter[] = ((df ?? []) as DocumentFilter[]).map((f) => {
    if (f.value === SELF) return { ...f, value: userId };
    if (f.op === "in" && Array.isArray(f.value))
      return { ...f, value: f.value.map((v: unknown) => (v === SELF ? userId : v)) };
    return f;
  });

  return {
    id: row.id,
    allowedFields: row.allowed_fields ?? [],
    // Which of those fields come back RAW rather than transformed. Never widened here: a field
    // only reaches this column if approveGrant checked its posture declares `unmask: allow`.
    unmaskedFields: row.unmasked_fields ?? [],
    documentFilter,
    verbs: row.verbs ?? ["read"],
    mode: row.mode ?? "direct",
    principals,
  };
}
