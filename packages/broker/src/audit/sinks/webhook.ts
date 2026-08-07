import { randomUUID } from "node:crypto";
import type { AuditSink } from "./types";

/**
 * POST each decision to a collector — a SIEM, a log shipper, an internal endpoint.
 *
 * Deliberately synchronous with the decision, not queued. A queue would make the write succeed
 * before the collector had it, which is precisely the guarantee this trail is supposed to give:
 * an allow whose record could not be written is not an allow. The cost is that a slow collector
 * slows every governed call, and an operator choosing this sink is choosing that.
 *
 * `fetch` is a runtime global, not an import — `packages/broker` still pulls in no HTTP library
 * (eslint.config.js, no-restricted-imports).
 */
export const webhookSink: AuditSink = {
  id: "webhook",
  async write(_app, e, opts) {
    if (!opts.url) throw new Error("audit sink `webhook` needs `audit.url`");
    const id = randomUUID();
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify({ type: "warehousd.audit", id, ...e }),
    });
    // Any non-2xx means the collector did not accept the decision. Thrown, so makeAuditWriter's
    // downgrade turns an unrecorded allow into a refusal — see sinks/types.ts.
    if (!res.ok) throw new Error(`audit webhook refused the event: ${res.status}`);
    return id;
  },
};
