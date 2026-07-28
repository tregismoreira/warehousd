import type { Pool } from "pg";
import type { QueryIntent, DocSearchIntent, RefusalReason } from "../types";

export async function writeAudit(app: Pool, e: {
  userId: string; env: "dev" | "live"; collection: string; orgId: string; intent: QueryIntent | DocSearchIntent | null;
  fieldsReturned: string[]; grantId: string | null;
  outcome: "allowed" | "refused"; reason: RefusalReason | string | null; via: string;
}): Promise<string> {
  // Broker query refusals use the fixed RefusalReason set; operational events (import,
  // regen) carry their own reason codes.
  const r = await app.query(
    `insert into app.audit_events
       (user_id, env, collection, org_id, intent, fields_returned, grant_id, outcome, reason, via)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [e.userId, e.env, e.collection, e.orgId, e.intent ? JSON.stringify(e.intent) : null,
     e.fieldsReturned, e.grantId, e.outcome, e.reason, e.via]);
  return r.rows[0].id;
}
