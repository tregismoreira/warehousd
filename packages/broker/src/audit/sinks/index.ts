import type { AuditSink } from "./types";
import { postgresSink } from "./postgres";
import { stdoutJsonSink } from "./stdout-json";
import { webhookSink } from "./webhook";

/**
 * Every destination an audited decision can go to.
 *
 * A fourth sink is one file and one line here — the same shape `dbProviders`, `deploy/targets` and
 * `collectionKinds` already use. Nothing outside this module may branch on a sink id.
 */
export const auditSinks = {
  postgres: postgresSink,
  "stdout-json": stdoutJsonSink,
  webhook: webhookSink,
} satisfies Record<string, AuditSink>;

export type AuditSinkId = keyof typeof auditSinks;

/** The zod enum's tuple. `z.enum` needs at least one member, which `Object.keys` cannot prove. */
export const AUDIT_SINK_IDS = Object.keys(auditSinks) as [AuditSinkId, ...AuditSinkId[]];

export const DEFAULT_AUDIT_SINK: AuditSinkId = "postgres";

export function auditSink(id: AuditSinkId | undefined): AuditSink {
  return auditSinks[id ?? DEFAULT_AUDIT_SINK];
}

export type { AuditSink, AuditSinkOptions } from "./types";
export { DEFAULT_SINK_TIMEOUT_MS } from "./types";
