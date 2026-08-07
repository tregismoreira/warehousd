import type { AuditSink } from "./types";
import { insertAuditEvent } from "../write";

/**
 * `app.audit_events` — the default, and the only sink the console can query.
 *
 * The audit browser, the access-review view and every "on what authority" question read this
 * table, so a deployment that switches to another sink keeps the trail and loses the console's
 * ability to show it. That is a real trade-off and it belongs in the config, said out loud.
 */
export const postgresSink: AuditSink = {
  id: "postgres",
  write: (app, e) => insertAuditEvent(app, e),
};
