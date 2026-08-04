import type { Pool } from "pg";
import type { BrokerContext, AuditId, RefusalReason } from "../types";
import { ACL_TABLE } from "../config/schema";
import { findCollection } from "../config/load";
import { pkOf, dataSchema } from "../config/collection";
import { ident } from "../sql/ident";
import { withOrg, writePool } from "../db/pools";
import { makeAuditWriter } from "../audit/decision";
import { isPrincipal } from "./principals";
import type { VerbDeps } from "../verbs/deps";

// Reading and writing a document's ACL.
//
// Authorization here is NOT a grant verb, and that is the point. A grant says which documents and
// which fields a caller may READ; widening who else may read something is a different act, and
// letting it ride on `update` would mean any grant that can edit a page can also unrestrict it.
// So it is authorised against the caller's standing instead: a console user with role
// admin/manager, or a client whose policy carries `can_manage_acl` (default false).
//
// There is deliberately no MCP tool for either verb. An untrusted proposer must not be able to
// widen access to anything, and a tool the model can call is exactly that.

/**
 * WHO is asking, not what they claim to be allowed.
 *
 * The adapter supplies identity only — a console session, or a client id — and the broker reads
 * the role or the flag from the database itself. An adapter that could assert "I am an admin"
 * would move the decision outside the trust boundary, which is the thing invariant 1 forbids.
 */
export type AclManager = { kind: "console" } | { kind: "client"; clientId: string };

export type DocumentAcl = {
  collection: string;
  documentId: string;
  principals: string[];
  updatedAt: string | null;
  updatedBy: string | null;
};

export type AclRefusalReason = RefusalReason | "acl_denied" | "not_writable";

export type GetAclResult =
  | { ok: true; acl: DocumentAcl; auditId: AuditId }
  | { ok: false; reason: AclRefusalReason; auditId: AuditId };

export type SetAclResult =
  | { ok: true; acl: DocumentAcl; auditId: AuditId }
  | { ok: false; reason: AclRefusalReason; auditId: AuditId };

// Roles that may manage an ACL from the console. Same ⊃ order as apps/web/lib/authz.ts: an admin
// is a manager. A `member` is not — a member's own grants say what they may read, and letting them
// rewrite an ACL would let them grant themselves a document their grant already covers but the
// ACL excludes.
const CONSOLE_ROLES = new Set(["admin", "manager"]);

async function mayManage(app: Pool, ctx: BrokerContext, who: AclManager): Promise<boolean> {
  if (who.kind === "console") {
    const r = await app.query<{ role: string | null }>(
      `select role from app."user" where id = $1 and "orgId" = $2`,
      [ctx.userId, ctx.orgId],
    );
    const role = r.rows[0]?.role;
    return typeof role === "string" && CONSOLE_ROLES.has(role);
  }
  const r = await app.query<{ can_manage_acl: boolean }>(
    `select can_manage_acl from app.client_policies where client_id = $1 and org_id = $2`,
    [who.clientId, ctx.orgId],
  );
  // No policy row is not "no ceiling" here the way it is for scopes: an unknown client has not
  // been granted anything, and the flag defaults false for a known one too.
  return r.rows[0]?.can_manage_acl === true;
}

export function makeAclVerbs(d: VerbDeps) {
  const { app, cfg, pools } = d;

  // The checks both verbs share, in one place so neither can be the lenient one.
  async function gate(
    ctx: BrokerContext,
    who: AclManager,
    collection: string,
    audit: ReturnType<typeof makeAuditWriter>,
  ): Promise<
    | { ok: true; schema: string; pk: string }
    | { ok: false; reason: AclRefusalReason; auditId: AuditId }
  > {
    const c = findCollection(cfg, collection);
    if (!c) return audit.refuse(collection, "unknown_collection");
    // A collection that does not declare `acl: true` has no `_acl` column on its view, so a row
    // written here would be inert — and an inert ACL that reports success is worse than a refusal.
    if (!c.acl) return audit.refuse(collection, "invalid_intent");
    const pk = pkOf(c);
    if (!pk) return audit.refuse(collection, "invalid_intent");
    // Authorization last of the three, so that "you may not" cannot be told apart from "there is
    // no such collection" by anyone who is not already authorised — the same information-leak
    // rule the read verbs follow with no_grant.
    if (!(await mayManage(app, ctx, who))) return audit.refuse(collection, "acl_denied");
    return { ok: true, schema: dataSchema(ctx.env), pk };
  }

  async function getDocumentAcl(
    ctx: BrokerContext,
    who: AclManager,
    args: { collection: string; id: string },
  ): Promise<GetAclResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
    // `gate` is INSIDE the try: it queries app."user" / app.client_policies, and a driver error
    // there must become an audited internal_error like any other, not an exception thrown at an
    // adapter that has no reason code to answer with.
    try {
      const g = await gate(ctx, who, args.collection, audit);
      if (!g.ok) return g;

      // The write pool, not the read pool: `_acl` is a base table and the read roles hold nothing
      // on it by design (they see views and nothing else — see aclTableDDL).
      const pool = writePool(pools, ctx);
      if (!pool) return audit.refuse(args.collection, "not_writable");

      const row = await withOrg(pool, ctx.orgId, async (client) => {
        const r = await client.query(
          `select principals, updated_at, updated_by from ${g.schema}.${ident(ACL_TABLE)}
           where org_id = $1 and collection = $2 and document_id = $3`,
          [ctx.orgId, args.collection, args.id],
        );
        return r.rows[0] ?? null;
      });

      const rec = await audit.allow(args.collection);
      if (!rec.ok) return rec;
      // No row is a legitimate answer, not a 404: it is what "this document is public" looks like.
      return {
        ok: true,
        acl: {
          collection: args.collection,
          documentId: args.id,
          principals: row?.principals ?? [],
          updatedAt: row ? new Date(row.updated_at).toISOString() : null,
          updatedBy: row?.updated_by ?? null,
        },
        auditId: rec.auditId,
      };
    } catch (err) {
      console.error("[broker] getDocumentAcl failed", { collection: args.collection, err });
      return audit.refuse(args.collection, "internal_error");
    }
  }

  async function setDocumentAcl(
    ctx: BrokerContext,
    who: AclManager,
    args: { collection: string; id: string; principals: unknown },
  ): Promise<SetAclResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
    // Inside the try for the same reason getDocumentAcl's is — see the note there.
    try {
      const g = await gate(ctx, who, args.collection, audit);
      if (!g.ok) return g;

      // Every principal must carry its namespace. A bare `alice` is ambiguous between a user id
      // and a group name, and the two are different populations — see acl/principals.ts.
      if (!Array.isArray(args.principals) || !args.principals.every(isPrincipal))
        return audit.refuse(args.collection, "invalid_intent");
      // Deduplicated so that the stored array is the set it represents; `&&` and `.some()` both
      // ignore duplicates, so keeping them would only make two equal ACLs compare unequal.
      const principals = [...new Set(args.principals)];

      const pool = writePool(pools, ctx);
      if (!pool) return audit.refuse(args.collection, "not_writable");

      const written = await withOrg(pool, ctx.orgId, async (client) => {
        // An empty list is how a document becomes public again, and the way to say that is to
        // remove the row — not to store an empty array. The read predicate treats a zero-length
        // ACL as public either way, but leaving rows behind would make "is this document
        // restricted?" a question about array length rather than about existence.
        //
        // This DELETE is the deliberate exception to the no-DELETE-on-data rule; see
        // grantAclWriteDDL in apply/ddl.ts for why an ACL is not content.
        if (principals.length === 0) {
          await client.query(
            `delete from ${g.schema}.${ident(ACL_TABLE)}
             where org_id = $1 and collection = $2 and document_id = $3`,
            [ctx.orgId, args.collection, args.id],
          );
          return null;
        }
        const r = await client.query(
          `insert into ${g.schema}.${ident(ACL_TABLE)}
             (org_id, collection, document_id, principals, updated_by)
           values ($1,$2,$3,$4,$5)
           on conflict (org_id, collection, document_id) do update
             set principals = excluded.principals,
                 updated_at = now(),
                 updated_by = excluded.updated_by
           returning principals, updated_at, updated_by`,
          [ctx.orgId, args.collection, args.id, principals, ctx.userId],
        );
        return r.rows[0];
      });

      const rec = await audit.allow(args.collection, {
        // The document is named through the intent, and the principals are the decision. Neither
        // is a field value, so neither is a disclosure the way a written row would be.
        intent: { op: "set_acl", collection: args.collection, id: args.id, principals },
      });
      if (!rec.ok) return rec;
      return {
        ok: true,
        acl: {
          collection: args.collection,
          documentId: args.id,
          principals: written?.principals ?? [],
          updatedAt: written ? new Date(written.updated_at).toISOString() : null,
          updatedBy: written?.updated_by ?? null,
        },
        auditId: rec.auditId,
      };
    } catch (err) {
      console.error("[broker] setDocumentAcl failed", { collection: args.collection, err });
      return audit.refuse(args.collection, "internal_error");
    }
  }

  return { getDocumentAcl, setDocumentAcl };
}

// Group membership, as warehousd's own record of it.
//
// `source` says who put the row there. An SSO login replaces only the rows it owns, so a
// console-pinned membership survives a re-sync — and an IdP that stops asserting a group does not
// silently delete what somebody granted by hand.

export type GroupSource = "sso" | "manual";

export async function listUserGroups(
  app: Pool,
  i: { orgId: string; userId: string },
): Promise<{ group: string; source: GroupSource }[]> {
  const r = await app.query<{ group_name: string; source: GroupSource }>(
    `select group_name, source from app.user_groups
     where org_id = $1 and user_id = $2 order by group_name, source`,
    [i.orgId, i.userId],
  );
  return r.rows.map((row) => ({ group: row.group_name, source: row.source }));
}

/**
 * Replace one source's memberships for one user. The other source is untouched.
 *
 * Delete-then-insert in one transaction, rather than an upsert plus a sweep: the set is the whole
 * of the answer, so anything not in it is gone, and doing that in two statements outside a
 * transaction would leave a window in which the user is in no group at all.
 */
export async function setUserGroups(
  app: Pool,
  i: { orgId: string; userId: string; groups: string[]; source: GroupSource },
): Promise<void> {
  const groups = [...new Set(i.groups.filter((g) => typeof g === "string" && g.length > 0))];
  const client = await app.connect();
  try {
    await client.query("begin");
    await client.query(`delete from app.user_groups where org_id=$1 and user_id=$2 and source=$3`, [
      i.orgId,
      i.userId,
      i.source,
    ]);
    if (groups.length)
      await client.query(
        `insert into app.user_groups (org_id, user_id, group_name, source)
         select $1, $2, g, $3 from unnest($4::text[]) as g
         on conflict (org_id, user_id, group_name, source) do update set updated_at = now()`,
        [i.orgId, i.userId, i.source, groups],
      );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Everyone in a group, for the console's ACL editor.
 *
 * Read-only and org-scoped. It answers "who would `group:editors` admit?" — which is the question
 * somebody adding a group to an ACL is actually asking.
 */
export async function listGroupMembers(
  app: Pool,
  i: { orgId: string; group: string },
): Promise<string[]> {
  const r = await app.query<{ user_id: string }>(
    `select distinct user_id from app.user_groups where org_id=$1 and group_name=$2 order by user_id`,
    [i.orgId, i.group],
  );
  return r.rows.map((row) => row.user_id);
}

/** Every group name in use in an org, from either source. */
export async function listGroups(app: Pool, orgId: string): Promise<string[]> {
  const r = await app.query<{ group_name: string }>(
    `select distinct group_name from app.user_groups where org_id=$1 order by group_name`,
    [orgId],
  );
  return r.rows.map((row) => row.group_name);
}
