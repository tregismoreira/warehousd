import type { Pool } from "pg";
import type { QueryIntent, DocSearchIntent, RefusalReason } from "../types";

// What a mutation records in place of its intent: the op and the field NAMES it touched, never
// the submitted values. Named here rather than cast away at the call site — the `as never` that
// used to bridge it hid the fact that this column holds three different shapes.
export type MutationAuditIntent = {
  op: string;
  collection: string;
  id?: string | undefined;
  fields: string[];
};

// Operational events (import, regen) carry their own shape and their own reason codes.
export type OperationalAuditIntent = { op: string } & Record<string, unknown>;

export type AuditIntent =
  QueryIntent | DocSearchIntent | MutationAuditIntent | OperationalAuditIntent | null;

/**
 * One audited decision, as every sink receives it.
 *
 * Named rather than inlined because the sink registry has to state what it is handed — see
 * audit/sinks/. The shape is unchanged.
 */
export type AuditEvent = {
  userId: string;
  env: "dev" | "live";
  collection: string;
  orgId: string;
  intent: AuditIntent;
  fieldsReturned: string[];
  // Which of fieldsReturned came back RAW rather than transformed. Names only, like
  // fieldsReturned itself — never a value.
  unmaskedFields?: string[];
  // The principal set the decision was made under — `user:<id>` plus the caller's groups as
  // `app.user_groups` held them at that instant. Recorded because reproducing "who could read
  // page 742 on the 4th" needs membership AS IT WAS, and app.user_groups only holds current
  // state. Same reasoning as unmaskedFields: a property of the DECISION, not of the request.
  principals?: readonly string[];
  grantId: string | null;
  // WHICH principal the grant was approved for — `user:<id>` or `group:<name>`. Recorded beside
  // the id for the same reason `principals` is recorded beside the user: a grant can be revoked,
  // and "this access came from a group membership" has to stay answerable after the row naming
  // it is gone.
  grantPrincipal?: string | null;
  // `string & {}` rather than a bare `string`: it keeps RefusalReason's members offered by
  // autocomplete while still admitting the operational codes the comment below describes. A plain
  // `RefusalReason | string` collapses to `string` and loses the hint.
  outcome: "allowed" | "refused";
  reason: RefusalReason | (string & {}) | null;
  via: string;
};

/**
 * Insert into `app.audit_events`. The `postgres` sink's implementation, and nothing else's.
 *
 * Every caller goes through `makeAuditWriter`, which routes to whichever sink the config names —
 * the import path and the console's regen included, since a deployment forwarding its trail
 * elsewhere must not keep some of it here. Exported for the registry alone.
 */
export async function insertAuditEvent(app: Pool, e: AuditEvent): Promise<string> {
  // Broker query refusals use the fixed RefusalReason set; operational events (import,
  // regen) carry their own reason codes.
  const r = await app.query(
    `insert into app.audit_events
       (user_id, env, collection, org_id, intent, fields_returned, unmasked_fields, principals,
        grant_id, grant_principal, outcome, reason, via)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [
      e.userId,
      e.env,
      e.collection,
      e.orgId,
      e.intent ? JSON.stringify(e.intent) : null,
      e.fieldsReturned,
      e.unmaskedFields ?? [],
      e.principals ?? [],
      e.grantId,
      e.grantPrincipal ?? null,
      e.outcome,
      e.reason,
      e.via,
    ],
  );
  return r.rows[0].id;
}

/**
 * @deprecated The direct-to-Postgres write. No production path uses it any more: the admin import
 * and the synthetic regen were the last two, and both now go through `makeAuditWriter` so they
 * reach the configured sink. Kept as an alias for the suites that assert on the row shape itself —
 * anything that RECORDS a decision must go through the writer, which owns the destination, the
 * `audit.enabled` gate and the downgrade rule.
 */
export const writeAudit = insertAuditEvent;
