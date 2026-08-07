import { randomUUID } from "node:crypto";
import { DEFAULT_SINK_TIMEOUT_MS, type AuditSink } from "./types";

/**
 * POST each decision to a collector — a SIEM, a log shipper, an internal endpoint.
 *
 * Deliberately synchronous with the decision, not queued. A queue would make the write succeed
 * before the collector had it, which is precisely the guarantee this trail is supposed to give:
 * an allow whose record could not be written is not an allow. The cost is that a slow collector
 * slows every governed call, and an operator choosing this sink is choosing that.
 *
 * **Bounded, always.** Synchronous-with-the-decision only works if the wait is finite: a collector
 * that accepts the connection and then goes quiet would otherwise hold every governed call open
 * until the platform gave up, which is a third party turning the audit trail into an outage. The
 * abort is a thrown error like any other failure, so a timeout downgrades an allow to a refusal
 * rather than silently succeeding — see sinks/types.ts.
 *
 * `fetch` is a runtime global, not an import — `packages/broker` still pulls in no HTTP library
 * (eslint.config.js, no-restricted-imports).
 */
export const webhookSink: AuditSink = {
  id: "webhook",
  async write(_app, e, opts) {
    if (!opts.url) throw new Error("audit sink `webhook` needs `audit.url`");
    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
        body: JSON.stringify({ type: "warehousd.audit", id, ...e }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Rethrown with the deadline named, because "the collector is slow" and "the collector is
      // unreachable" are different operational problems with the same symptom here. The event
      // itself is NOT in this message — it carries field names, and the log line is written by
      // makeAuditWriter, which redacts.
      const why = (err as { name?: string }).name === "TimeoutError" ? "timed out" : "failed";
      throw new Error(`audit webhook ${why} after ${timeoutMs}ms`, { cause: err });
    }
    // Any non-2xx means the collector did not accept the decision. Thrown, so makeAuditWriter's
    // downgrade turns an unrecorded allow into a refusal — see sinks/types.ts.
    if (!res.ok) throw new Error(`audit webhook refused the event: ${res.status}`);
    return id;
  },
};
