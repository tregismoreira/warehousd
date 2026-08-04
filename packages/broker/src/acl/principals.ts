import type { Pool, PoolClient } from "pg";
import type { BrokerContext } from "../types";

// Who a caller *is*, for the purposes of a per-document ACL.
//
// Principals are namespaced — `user:<userId>` and `group:<name>` — and the namespace is not
// decoration. Without it a group named the same as a user id would grant that user's access, and
// an ACL author would have no way to say which of the two they meant. The prefix is validated on
// write (acl/manage.ts) and applied on read (below), so the two sides cannot spell it apart.
//
// Group membership is warehousd's own fact. It is read from `app.user_groups` on every call and
// derived from `ctx.userId` — never from a token, a claim, or anything a caller supplies. The
// broker is the trust boundary (invariant 1), and a per-document deny that depends on an assertion
// minted outside it is not a deny; this is the same reasoning grants/eval.ts gives for refusing to
// bake grants into tokens.

export const USER_PREFIX = "user:";
export const GROUP_PREFIX = "group:";

export function userPrincipal(userId: string): string {
  return `${USER_PREFIX}${userId}`;
}

export function groupPrincipal(group: string): string {
  return `${GROUP_PREFIX}${group}`;
}

// A principal is well-formed when it carries one of the two namespaces and something after it.
// Refused rather than normalised: a bare `alice` is ambiguous between a user id and a group name,
// and guessing which an ACL author meant is how an ACL widens by accident.
export function isPrincipal(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (p.startsWith(USER_PREFIX)) return p.length > USER_PREFIX.length;
  if (p.startsWith(GROUP_PREFIX)) return p.length > GROUP_PREFIX.length;
  return false;
}

// The caller's principal set: themselves, plus every group they are in, in this org.
//
// Both sources are returned regardless of `source` — an sso-asserted membership and a
// console-pinned one are the same fact about the caller, and which of the two put the row there
// is an administrative question, not an access-control one.
export async function loadPrincipals(
  db: Pool | PoolClient,
  ctx: Pick<BrokerContext, "userId" | "orgId">,
): Promise<string[]> {
  const r = await db.query<{ group_name: string }>(
    `select distinct group_name from app.user_groups where org_id = $1 and user_id = $2`,
    [ctx.orgId, ctx.userId],
  );
  return [userPrincipal(ctx.userId), ...r.rows.map((row) => groupPrincipal(row.group_name))];
}

// The in-process half of the ACL rule. The other half is `aclPredicate` in acl/sql.ts, which says
// the same thing in SQL; the two are asserted against each other in test/acl-parity.test.ts.
//
// `null` and an empty array both mean "no ACL row", which is the public case — matching
// `coalesce(array_length("_acl", 1), 0) = 0`. `undefined` is not the same thing and must never be
// read as public: it means the caller's query did not fetch the column at all, and answering
// "public" there would turn a forgotten join into a silent leak. Callers reach this through
// `admits()` in grants/filters.ts, which fails closed on that case.
export function aclAdmits(acl: readonly string[] | null, principals: readonly string[]): boolean {
  if (acl === null || acl.length === 0) return true;
  return acl.some((p) => principals.includes(p));
}
