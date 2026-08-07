import { randomUUID } from "node:crypto";
import type { AuditSink } from "./types";

/**
 * One JSON object per decision on stdout, for a log pipeline that already collects them.
 *
 * The id is generated here rather than by a database, which is the honest answer: it identifies
 * the decision in whatever the pipeline stores, and a caller holding it can correlate a response
 * with a log line. Nothing in warehousd can look it up, because nothing in warehousd wrote it
 * down — an operator choosing this sink is choosing that.
 *
 * `process.stdout.write` rather than `console.log`: a partial write on a full pipe throws, which
 * is exactly the failure the downgrade rule exists for. A silent drop would leave an allow
 * standing on a decision nobody recorded.
 */
export const stdoutJsonSink: AuditSink = {
  id: "stdout-json",
  write(_app, e) {
    const id = randomUUID();
    process.stdout.write(`${JSON.stringify({ type: "warehousd.audit", id, ...e })}\n`);
    return Promise.resolve(id);
  },
};
