import type { Pool } from "pg";
import type { AuditId, BrokerContext, RefusalReason } from "../types";
import { findCollection, maskedFieldsFor } from "../config/load";
import { isGrantable, readPosture, unmaskPosture, writePosture } from "../config/schema";
import { loadActiveGrant } from "../grants/eval";
import { loadPrincipals } from "../acl/principals";
import { makeAuditWriter } from "../audit/decision";
import { buildSelect, UnsupportedFilter } from "../sql/build";
import { dataPool, withOrg } from "../db/pools";
import { validateDocumentFilters } from "../grants/filters";
import { aclOpts } from "./guard";
import type { VerbDeps } from "./deps";

// "Why can't Ana see salaries.base_salary?"
//
// There was no answer to that anywhere. Refusal codes are deliberately opaque to the MODEL — a
// caller that could tell `field_denied` from `no_grant` from "that field is masked" could map the
// shape of what it cannot see — and that is right. But the human console inherited the opacity for
// no reason: an approver picks fields with no preview, an admin cannot see what somebody actually
// holds, and a member has no way to self-diagnose.
//
// So this is a SEPARATE verb with a separate authorisation, exactly like setDocumentAcl: it is not
// reachable through any grant, there is no MCP tool for it, and it is audited like every other
// decision. It answers about a SUBJECT, to a caller who is entitled to ask about that subject.

/**
 * WHO is asking. Identity only — the broker reads the role from the database itself, because an
 * adapter that could assert "I am an admin" would move the decision outside the trust boundary.
 */
export type ExplainAsker = { kind: "console" };

export type FieldExplanation = {
  field: string;
  /** What the CONFIG says. The ceiling: no grant can widen it. */
  posture: "allow" | "mask" | "deny";
  /** Whether a grant may carry this field at all — `posture !== deny`. */
  grantable: boolean;
  /** Whether the subject's current grant carries it. */
  granted: boolean;
  /** What the subject would actually receive: the raw value, a transform, or nothing. */
  effect: "raw" | "masked" | "none";
  /** Whether the config declares the RAW value grantable for a masked field. */
  unmaskable: boolean;
  /** Whether this grant carries the raw value. */
  unmasked: boolean;
  /** Whether a write would be accepted, config-side. */
  writable: boolean;
  /**
   * The FIRST rule that said no, in the order the broker applies them, or null where nothing did.
   * This is the whole point of the verb: "denied" and "not in your grant" and "masked" are three
   * different problems with three different people who can fix them.
   */
  blockedBy: "posture" | "no_grant" | "not_in_grant" | "masked" | null;
};

export type AccessExplanation = {
  collection: string;
  subject: string;
  /** The grant that would decide, or null. Named so §P1's specificity rule is legible. */
  grant: {
    id: string;
    principal: string;
    verbs: string[];
    mode: string;
    expiresAt: string | null;
    /** Every principal the subject holds, so an inherited grant is visibly inherited. */
    via: string[];
  } | null;
  fields: FieldExplanation[];
  /**
   * How many documents the grant's filter and ACL actually reach, or null where there is no grant
   * to count through.
   *
   * The approve sheet's missing half: a manager picking a `document_filter` had no way to tell a
   * predicate that scopes access from one that matches nothing. Counted through the same
   * `buildSelect` a real read uses — including the ACL predicate — so it is what the subject would
   * see rather than a second guess at it.
   */
  matchedDocuments: number | null;
  auditId: AuditId;
};

export type ExplainResult =
  | ({ ok: true } & AccessExplanation)
  | { ok: false; reason: RefusalReason | "not_authorized"; auditId: AuditId };

// admin ⊃ manager, the same order apps/web/lib/authz.ts ranks them in. A member is not on this
// list for the same reason they cannot manage an ACL: this verb answers about OTHER people.
const CONSOLE_ROLES = new Set(["admin", "manager"]);

async function roleOf(app: Pool, ctx: BrokerContext): Promise<string | null> {
  const r = await app.query<{ role: string | null }>(
    `select role from app."user" where id = $1 and "orgId" = $2`,
    [ctx.userId, ctx.orgId],
  );
  return r.rows[0]?.role ?? null;
}

export function makeExplainVerb(d: VerbDeps) {
  const { app, cfg } = d;

  /**
   * What `subjectUserId` can see of `collection`, field by field, and why.
   *
   * Asking about YOURSELF needs no role: "I can't see X" has to be self-diagnosable, and nothing
   * here tells you anything your own refusals would not eventually tell you anyway. Asking about
   * SOMEBODY ELSE is a manager's act.
   *
   * Nothing it returns is a field VALUE. It describes the shape of a policy, which is what makes
   * it safe to render in a console — and it names a `deny` field, which a grant-carrying caller
   * would never learn, precisely because the caller is a person who can read warehousd.yml.
   */
  async function explainAccess(
    ctx: BrokerContext,
    _who: ExplainAsker,
    collection: string,
    subjectUserId: string,
  ): Promise<ExplainResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);

    const isSelf = subjectUserId === ctx.userId;
    if (!isSelf) {
      const role = await roleOf(app, ctx);
      if (role === null || !CONSOLE_ROLES.has(role))
        return audit.refuse(collection, "not_authorized");
    }

    const c = findCollection(cfg, collection);
    if (!c) return audit.refuse(collection, "unknown_collection");

    // The subject's grant, resolved exactly as a real call would resolve it — same loader, same
    // specificity ordering, same ceiling. A second implementation here would be a second answer
    // to "what would happen", which is the one thing this verb must not have.
    const subjectCtx = {
      userId: subjectUserId,
      orgId: ctx.orgId,
      env: ctx.env,
      // The SUBJECT's ceiling, not the asker's. A console user asking about somebody else is not
      // acting through a client, so there is none — the answer describes what the subject holds,
      // and any client they use narrows it further at call time.
      allowedCollections: null,
    };
    const grant = await loadActiveGrant(app, subjectCtx, collection);
    const via = await loadPrincipals(app, subjectCtx);

    const masked = new Set(maskedFieldsFor(cfg, collection, grant?.unmaskedFields ?? []));

    const fields: FieldExplanation[] = Object.entries(c.fields).map(([field, f]) => {
      const posture = readPosture(f);
      const grantable = isGrantable(f);
      const granted = grant?.allowedFields.includes(field) ?? false;
      const unmasked = grant?.unmaskedFields.includes(field) ?? false;

      // The order is the order the broker applies them, which is what makes "the first rule that
      // said no" a useful sentence rather than a list of everything that is not true.
      const blockedBy: FieldExplanation["blockedBy"] = !grantable
        ? "posture"
        : !grant
          ? "no_grant"
          : !granted
            ? "not_in_grant"
            : masked.has(field)
              ? "masked"
              : null;

      return {
        field,
        posture,
        grantable,
        granted,
        effect: blockedBy === null ? "raw" : blockedBy === "masked" ? "masked" : "none",
        unmaskable: unmaskPosture(f) === "allow",
        unmasked,
        writable: writePosture(f) === "allow",
        blockedBy,
      };
    });

    const matchedDocuments = grant ? await countMatched(d, ctx, collection, grant) : null;

    const rec = await audit.allow(collection, {
      // Field NAMES, which is what this verb returns — never a value. Recorded because "who asked
      // what somebody else could see" is itself a question a compliance reviewer will ask.
      fieldsReturned: fields.map((f) => f.field),
      ...(grant ? { grant } : {}),
    });
    if (!rec.ok) return rec;

    return {
      ok: true,
      collection,
      subject: subjectUserId,
      grant: grant
        ? {
            id: grant.id,
            principal: grant.principal,
            verbs: grant.verbs,
            mode: grant.mode,
            expiresAt: grant.expiresAt,
            via,
          }
        : null,
      fields,
      matchedDocuments,
      auditId: rec.auditId,
    };
  }

  return { explainAccess };
}

/**
 * How many documents this grant reaches.
 *
 * A `count(*)` aggregate through `buildSelect`, so the grant's document filters and its ACL
 * predicate land in the same WHERE a real read would put them in — which is the only way the
 * number means anything. A collection with no view in this environment, or a filter the builder
 * cannot express, counts as null rather than zero: "not applicable" and "matches nothing" are
 * different answers and an approver needs to tell them apart.
 */
async function countMatched(
  d: VerbDeps,
  ctx: BrokerContext,
  collection: string,
  grant: Awaited<ReturnType<typeof loadActiveGrant>> & object,
): Promise<number | null> {
  const c = findCollection(d.cfg, collection);
  if (!c) return null;
  // An unevaluable filter refuses every read, so counting through it would report a number for a
  // grant that cannot be used at all.
  if (validateDocumentFilters(grant.documentFilter, c)) return null;
  const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
  const countable = pk ?? grant.allowedFields[0];
  if (!countable) return null;
  try {
    const { text, values } = buildSelect(
      ctx.env,
      { collection, aggregate: [{ fn: "count", field: countable }] },
      // The count is over DOCUMENTS, not over fields, so the field set is whatever the grant
      // carries — widening it here would count nothing extra and narrow nothing.
      [countable, ...grant.allowedFields],
      {
        documentFilters: grant.documentFilter,
        isMultiValueField: d.isMultiValueField,
        maskFor: () => null,
        ...aclOpts(c, grant),
      },
    );
    return await withOrg(dataPool(d.pools, ctx), ctx.orgId, async (client) => {
      const r = await client.query(text, values);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      const n = row ? Object.values(row)[0] : undefined;
      return n === undefined || n === null ? null : Number(n);
    });
  } catch (err) {
    if (err instanceof UnsupportedFilter) return null;
    // A collection that was never applied to this environment has no view. That is an answer, not
    // a fault, and it must not take the whole explanation down with it.
    console.error("[broker] explainAccess count failed", { collection, err });
    return null;
  }
}
