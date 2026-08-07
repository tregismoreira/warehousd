import type { Pool } from "pg";
import type { AuditEvent } from "../write";

/**
 * Where an audited decision goes.
 *
 * `writeAudit` inserted into `app.audit_events` and nowhere else, and `audit.enabled` was a
 * boolean — so a deployment that had to forward its trail to a SIEM had no way to say so, and one
 * that wanted the trail on stdout for a log pipeline had to run a database it did not otherwise
 * need. `makeAuditWriter` was already the single seam, so this is a registry behind it.
 *
 * **The downgrade rule is unchanged and is the whole reason to trust the trail.** A sink that
 * cannot record a decision must THROW: `makeAuditWriter` catches it, an allow becomes an
 * `internal_error` refusal, and the operator gets a loud log line. A sink that swallows its own
 * failure turns the guarantee into a hope.
 */
export type AuditSink = {
  id: string;
  /**
   * Record one decision and return the id it was recorded under.
   *
   * `app` is the control-plane pool. A sink that does not use it still receives it — the
   * alternative is a registry whose entries take different arguments, which is how one of them
   * ends up being constructed somewhere else.
   */
  write(app: Pool, e: AuditEvent, opts: AuditSinkOptions): Promise<string>;
};

export type AuditSinkOptions = {
  /** Required by `webhook`; ignored by the others. */
  url?: string | undefined;
  /** Extra headers for `webhook` — an authorization token, typically. */
  headers?: Record<string, string> | undefined;
};
