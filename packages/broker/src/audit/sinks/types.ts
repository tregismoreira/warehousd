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
 *
 * The one place that rule bends is an OPERATIONAL event whose work is already committed by the
 * time the write is attempted — the admin import and the synthetic regen, whose audit row goes
 * through the app pool and so cannot join the transaction it describes. Those still go through the
 * writer, and so still reach the configured sink; they just cannot un-import a file to punish a
 * collector for being down. The failure is logged, and the result carries a null id.
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
  /**
   * How long `webhook` waits for the collector before giving up, in milliseconds.
   *
   * There has to be one, and it has to be finite. The sink is synchronous with the decision by
   * design, so a collector that accepts the connection and then never answers would hold the
   * request path open for as long as the platform allows — an audit destination nobody controls
   * turned into a denial of service on the broker. A timeout is a FAILED write, which means the
   * downgrade rule applies and the allow becomes a refusal; that is the safe direction, and it is
   * the only one consistent with "an allow whose record could not be written is not an allow".
   */
  timeoutMs?: number | undefined;
};

/** Applied when `audit.timeout_ms` is not set. Long enough for a slow collector, short enough
 * that a hung one is a failure rather than a hang. */
export const DEFAULT_SINK_TIMEOUT_MS = 5_000;
