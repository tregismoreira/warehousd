import type { Pool } from "pg";
import type {
  BrokerContext,
  MutationIntent,
  MutationRefusalReason,
  MutationResult,
} from "../types";
import type { AuditIntent } from "./write";
import type { AuditConfig } from "../config/schema";
import { auditSink, type AuditSinkId, type AuditSinkOptions } from "./sinks";
import { redact } from "../log/redact";

// One decision, one audit row. Every broker verb ends in exactly one of these two calls.
//
// The ten-field `writeAudit(app, { userId: ctx.userId, env: ctx.env, … })` literal appeared
// twenty-five times in broker.ts. Nine of those fields were the same nine every time, derived from
// `ctx`, which is what made the block long enough to copy and long enough to get subtly wrong: a
// refusal that recorded `outcome: "allowed"`, or a mutation refusal that recorded the query-shaped
// `intent: null`, reads as a correct audit row and is not one.
//
// Binding `(app, ctx)` once per verb call leaves only what actually varies — the collection, the
// outcome, and the handful of optional details.

// What a decision was made under: the grant's id, and the principal set that decided which
// individual documents it reached. The two travel together because they are one answer to "on
// what authority" — recording the grant without the membership leaves the ACL half of the
// decision unreproducible the moment somebody leaves a group.
//
// `ActiveGrant` satisfies this structurally, so verbs pass the grant they already loaded.
//
// `principal` is WHICH principal the grant itself was approved for — `user:<id>` or
// `group:<name>` — as distinct from `principals`, the caller's whole membership set. Once a grant
// can belong to a group the id alone stops answering "on what authority": a revoked group grant
// leaves an audit row naming a row that no longer exists, and only the principal still says the
// access came from a membership rather than from a personal decision.
export type AuditGrant = { id: string; principals: readonly string[]; principal?: string };

export type AuditDetail = {
  // A query or search records its intent verbatim; a mutation records op + field names only (see
  // MutationAuditIntent). Absent means the verb has no intent to record.
  intent?: AuditIntent;
  fieldsReturned?: string[];
  // Which of fieldsReturned came back raw rather than masked. Only the read verbs set it.
  unmaskedFields?: string[];
  // The grant this decision ran under, or null where the decision was reached before one was
  // loaded (unknown_collection, no_grant). Supersedes the old `grantId`: passing the grant rather
  // than its id is what carries `principals` onto the audit row without a second parameter every
  // call site could forget.
  grant?: AuditGrant | null;
};

// Where an audit write is attempted at all, it is not best-effort. If it fails, the verb it was
// recording did not happen as far as the system of record is concerned, so the caller must not be
// told it succeeded.
//
// Before this, ~25 `await writeAudit(…)` calls were unguarded. A failing insert threw out of the
// verb — including out of `query`'s own catch block, whose refusal path is itself an audit write —
// and the caller got an unhandled 500 with no audit row: exactly the outcome the comments call
// "the non-negotiable part". Nothing here fabricates an id to paper over that; the failure becomes
// a refusal the caller can read, and a loud log line for the operator.
//
// A deployment can also switch the trail off entirely (`audit.enabled: false`, for lower
// environments). That is the reason `auditId` is nullable on an *allow* and not only on a refusal:
// with auditing off there was never a row to name. The two nulls are told apart by `enabled`, not
// by inspecting the id — see `sealed` below, and audit-disabled.test.ts.
export type AuditedAllow =
  { ok: true; auditId: string | null } | { ok: false; reason: "internal_error"; auditId: null };

export type AuditedRefusal<R extends string> = { ok: false; reason: R; auditId: string | null };

export type AuditWriter = {
  // Record a successful decision. The caller MUST branch on `ok` — an allow whose audit row could
  // not be written is a refusal, and returning the result object directly propagates that.
  // `collection` is null for an operational, platform-level event with no associated collection.
  allow(collection: string | null, detail?: AuditDetail): Promise<AuditedAllow>;
  // Record a refusal. The refusal stands whether or not the row was written — there is nothing to
  // withhold — so this yields the reason the caller asked for, with a null id if the log failed.
  refuse<R extends string>(
    collection: string | null,
    reason: R,
    detail?: AuditDetail,
  ): Promise<AuditedRefusal<R>>;
  // The mutation forms. Separate because a mutation's audited intent is not its intent: it records
  // the op and the field NAMES only. Going through these rather than through `allow`/`refuse` with
  // a hand-built intent is what stops one mutation refusal from auditing differently than the
  // identical one three lines below it.
  allowMutation(
    i: MutationIntent,
    grant: AuditGrant | null,
    fields: string[],
  ): Promise<AuditedAllow>;
  refuseMutation(
    i: MutationIntent,
    grant: AuditGrant | null,
    reason: MutationRefusalReason,
  ): Promise<MutationResult>;
};

// Raised to abort a data transaction whose decision could not be recorded.
//
// `allow` inside `withWorkspace` is the one place returning the refusal is not enough: withWorkspace commits
// on a normal return, so the write would land with no audit row and the caller would be told
// internal_error — the worst of both. Throwing rolls the transaction back, and the verb's existing
// catch turns it into the same controlled refusal (and re-attempts the refusal's own audit row,
// which records that the operation was rejected).
export class AuditWriteFailed extends Error {
  constructor() {
    super("audit write failed — transaction rolled back");
  }
}

export function assertRecorded(
  rec: AuditedAllow,
): asserts rec is { ok: true; auditId: string | null } {
  if (!rec.ok) throw new AuditWriteFailed();
}

// A mutation's audit intent records the op and the field NAMES it touched — never the submitted
// values. This is a deliberate departure from query, whose intent is safe to store verbatim: a
// write payload can carry real personal data, and an audit row is readable by every admin in the UI.
function mutationIntent(i: MutationIntent, fields: string[]) {
  return { op: i.op, collection: i.collection, id: "id" in i ? i.id : undefined, fields };
}

// `enabled` has no default on purpose. A default of `true` would be the safe value, but it would
// also let a new call site forget the flag and keep auditing in a deployment that asked not to be
// audited — silently, and only on that one verb. Required means the compiler names every site.
/**
 * Where this deployment's decisions go, and any options that destination needs.
 *
 * Resolved once per broker from `audit:` in warehousd.yml (verbs/deps.ts) rather than read at each
 * call site, so "where does the trail go" has one answer for the life of the broker.
 */
export type AuditDestination = { sink?: AuditSinkId | undefined } & AuditSinkOptions;

/**
 * The destination `audit:` in warehousd.yml names, as the writer takes it.
 *
 * One reader for the whole codebase. Three call sites need it — the verb deps, the import path and
 * the console's regen — and a second hand-written copy is how one of them ends up still writing to
 * Postgres after the deployment has been pointed at a SIEM.
 *
 * Every field is optional-chained: a hand-built config object never went through zod's defaults,
 * so the whole block can be genuinely absent, and absent means the default sink — which is what
 * every deployment had before sinks existed.
 */
export function auditDestination(cfg: { audit?: AuditConfig | undefined }): AuditDestination {
  return {
    sink: cfg.audit?.sink,
    ...(cfg.audit?.url ? { url: cfg.audit.url } : {}),
    ...(cfg.audit?.headers ? { headers: cfg.audit.headers } : {}),
    ...(cfg.audit?.timeout_ms ? { timeoutMs: cfg.audit.timeout_ms } : {}),
  };
}

export function makeAuditWriter(
  app: Pool,
  ctx: BrokerContext,
  enabled: boolean,
  destination: AuditDestination = {},
): AuditWriter {
  async function record(
    collection: string | null,
    outcome: "allowed" | "refused",
    reason: string | null,
    detail: AuditDetail,
  ): Promise<string | null> {
    if (!enabled) return null;
    try {
      // Through the registry, never a hard-coded insert: the downgrade below is what makes any
      // sink trustworthy, and it only works because a sink that cannot record a decision throws.
      return await auditSink(destination.sink).write(
        app,
        {
          userId: ctx.userId,
          env: ctx.env,
          collection,
          workspaceId: ctx.workspaceId,
          intent: detail.intent ?? null,
          fieldsReturned: detail.fieldsReturned ?? [],
          unmaskedFields: detail.unmaskedFields ?? [],
          principals: detail.grant?.principals ?? [],
          grantId: detail.grant?.id ?? null,
          grantPrincipal: detail.grant?.principal ?? null,
          outcome,
          reason,
          via: ctx.via,
        },
        destination,
      );
    } catch (err) {
      // Loud, and with enough to reconstruct the decision that went unrecorded — this line is the
      // only remaining trace of it.
      //
      // Through redact() because of what a pg error carries: Postgres puts row values in the
      // DETAIL field ("Key (email)=(a@b.com) already exists"), so logging the driver error whole
      // is a way for a denied value to reach a log line — the half of invariant 4 that is easiest
      // to forget. See packages/broker/src/log/redact.ts.
      console.error(
        "[broker] AUDIT WRITE FAILED — decision not recorded",
        redact({
          collection,
          outcome,
          reason,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          env: ctx.env,
          // Spread separately from name/message: those two are non-enumerable on an Error, while
          // a driver's own fields (detail, table, column) are enumerable and are what redact()
          // needs to see.
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, ...(err as unknown as object) }
              : err,
        }),
      );
      return null;
    }
  }

  // An allow is only an allow once the row exists — where a row was expected. This is the whole of
  // the downgrade rule, and the whole of what `audit.enabled: false` changes about it.
  //
  // Two ways to reach a null id, and only one of them is a failure. With auditing ON it means the
  // insert threw: the decision went unrecorded, so the allow does not stand. With auditing OFF it
  // is the configured answer — no row was ever coming — and downgrading there would turn every
  // read in a lower environment into an internal_error.
  const sealed = (auditId: string | null): AuditedAllow =>
    auditId === null && enabled
      ? { ok: false, reason: "internal_error", auditId: null }
      : { ok: true, auditId };

  return {
    async allow(collection, detail = {}) {
      return sealed(await record(collection, "allowed", null, detail));
    },
    async refuse(collection, reason, detail = {}) {
      return { ok: false, reason, auditId: await record(collection, "refused", reason, detail) };
    },
    async allowMutation(i, grant, fields) {
      return sealed(
        await record(i.collection, "allowed", null, { intent: mutationIntent(i, fields), grant }),
      );
    },
    async refuseMutation(i, grant, reason) {
      // The field names a refused mutation touched, taken from the intent itself. A delete carries
      // no values, so it names none.
      const fields = i.op === "delete" ? [] : Object.keys(i.values);
      const auditId = await record(i.collection, "refused", reason, {
        intent: mutationIntent(i, fields),
        grant,
      });
      return { ok: false, reason, auditId };
    },
  };
}
