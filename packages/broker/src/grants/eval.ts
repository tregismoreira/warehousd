import type { Pool } from "pg";
import type { BrokerContext, DocumentFilter } from "../types";
import { SELF } from "./filters";
import { loadPrincipals, USER_PREFIX } from "../acl/principals";

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
  // When this grant stops applying, ISO-8601, or null for one with no expiry.
  //
  // Enforced in the loader's predicate, not here — this is the value, for a console that has to
  // say WHEN rather than merely that it has not happened yet. §P7's expiring-soon panel and
  // explainAccess both need it, and re-querying for one column at each of those would be a second
  // answer to a question the grant already carries.
  expiresAt: string | null;
  // WHICH principal this grant was approved for — `user:<id>` or `group:<name>`.
  //
  // It rides on the grant because "on what authority" is not answerable from the id alone once
  // the grant can belong to a group: a revoked group grant leaves an audit row naming an id that
  // no longer exists, and the principal is what still says the access came from a membership
  // rather than from a personal decision.
  principal: string;
};

// Which of several matching grants wins. Only ever one — see the comment on loadActiveGrant.
//
// `user:` sorts before `group:` so the personal grant wins, then the most recent request. Written
// once here because the single-collection loader and the batch loader must not order differently:
// a caller that saw one grant through `query` and another through `changes` would be looking at
// two different access decisions for the same collection.
const SPECIFICITY = `order by (principal like '${USER_PREFIX}%') desc, requested_at desc`;

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

  // The principal set has to be in hand BEFORE the grant query now, because it is what the query
  // matches on. It is still loaded fresh on every call and never cached — a membership removed a
  // second ago must take effect on the next request, which is the whole reason grants are not
  // baked into tokens.
  const principals = await loadPrincipals(db, ctx);

  // ONE grant wins, chosen by specificity: `user:` beats `group:`, then most recently requested.
  //
  // The alternatives were all worse, and the reason is the same in each case — the audit row
  // records `{ id, principal }`, and an answer that is not a single stored grant is an answer
  // nobody can reproduce:
  //
  //   - A UNION of allowed_fields silently widens a narrow, purpose-bound personal grant to the
  //     group's, has no id to record, and — worst — revoking the personal grant would not remove
  //     access, which is the opposite of what the revoke button promises.
  //   - MOST PERMISSIVE is the union with extra steps, and makes buildApproval's "an approver
  //     trims, never widens" false.
  //   - MOST RECENT is arbitrary: a group grant edited last week would supersede a deliberate
  //     personal decision made yesterday.
  //
  // Specificity has one honest cost: a personal grant NARROWER than the user's inherited group
  // grant reduces their access, which surprises people. approveGrant warns about exactly that
  // (see `narrowerThanInherited`), and §P5's explainAccess is what makes it legible.
  const r = await db.query(
    `select id, allowed_fields, unmasked_fields, document_filter, verbs, mode, principal,
       expires_at
     from app.grants
     where principal = any($1) and collection=$2 and env=$3 and org_id=$4
       and status='approved' and (expires_at is null or expires_at > now())
     ${SPECIFICITY} limit 1`,
    [principals, collection, env, orgId],
  );
  if (r.rowCount === 0) return null;
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

  // One membership lookup for the whole batch: principals are a property of the caller, not of a
  // collection, so asking per grant would be the same answer N times.
  const principals = await loadPrincipals(db, ctx);

  // `distinct on (collection)` with the SAME specificity ordering the single loader uses, so a
  // group grant loses to a personal one identically either way.
  const r = await db.query(
    `select distinct on (collection) collection, id, allowed_fields, unmasked_fields,
       document_filter, verbs, mode, principal, expires_at
     from app.grants
     where principal = any($1) and collection = any($2) and env=$3 and org_id=$4
       and status='approved' and (expires_at is null or expires_at > now())
     order by collection, (principal like '${USER_PREFIX}%') desc, requested_at desc`,
    [principals, asked, env, orgId],
  );

  if (r.rowCount === 0) return out;
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
    principal?: string | null;
    expires_at?: Date | string | null;
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
    expiresAt:
      row.expires_at instanceof Date ? row.expires_at.toISOString() : (row.expires_at ?? null),
    principals,
    // A row without one predates migration 0007, which backfilled every existing grant — so this
    // fallback only ever fires for a hand-built row in a test.
    principal: row.principal ?? `${USER_PREFIX}${userId}`,
  };
}
