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

export async function writeAudit(
  app: Pool,
  e: {
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
    // `string & {}` rather than a bare `string`: it keeps RefusalReason's members offered by
    // autocomplete while still admitting the operational codes the comment below describes. A plain
    // `RefusalReason | string` collapses to `string` and loses the hint.
    outcome: "allowed" | "refused";
    reason: RefusalReason | (string & {}) | null;
    via: string;
  },
): Promise<string> {
  // Broker query refusals use the fixed RefusalReason set; operational events (import,
  // regen) carry their own reason codes.
  const r = await app.query(
    `insert into app.audit_events
       (user_id, env, collection, org_id, intent, fields_returned, unmasked_fields, principals, grant_id, outcome, reason, via)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
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
      e.outcome,
      e.reason,
      e.via,
    ],
  );
  return r.rows[0].id;
}
