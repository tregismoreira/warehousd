import type { Pool } from "pg";
import type {
  BrokerContext,
  MutationIntent,
  MutationRefusalReason,
  MutationResult,
} from "../types";
import { writeAudit, type AuditIntent } from "./write";
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

export type AuditDetail = {
  // A query or search records its intent verbatim; a mutation records op + field names only (see
  // MutationAuditIntent). Absent means the verb has no intent to record.
  intent?: AuditIntent;
  fieldsReturned?: string[];
  // Which of fieldsReturned came back raw rather than masked. Only the read verbs set it.
  unmaskedFields?: string[];
  grantId?: string | null;
};

// The audit write is not best-effort. If it fails, the verb it was recording did not happen as far
// as the system of record is concerned, so the caller must not be told it succeeded.
//
// Before this, ~25 `await writeAudit(…)` calls were unguarded. A failing insert threw out of the
// verb — including out of `query`'s own catch block, whose refusal path is itself an audit write —
// and the caller got an unhandled 500 with no audit row: exactly the outcome the comments call
// "the non-negotiable part". Nothing here fabricates an id to paper over that; the failure becomes
// a refusal the caller can read, and a loud log line for the operator.
export type AuditedAllow =
  { ok: true; auditId: string } | { ok: false; reason: "internal_error"; auditId: null };

export type AuditedRefusal<R extends string> = { ok: false; reason: R; auditId: string | null };

export type AuditWriter = {
  // Record a successful decision. The caller MUST branch on `ok` — an allow whose audit row could
  // not be written is a refusal, and returning the result object directly propagates that.
  allow(collection: string, detail?: AuditDetail): Promise<AuditedAllow>;
  // Record a refusal. The refusal stands whether or not the row was written — there is nothing to
  // withhold — so this yields the reason the caller asked for, with a null id if the log failed.
  refuse<R extends string>(
    collection: string,
    reason: R,
    detail?: AuditDetail,
  ): Promise<AuditedRefusal<R>>;
  // The mutation forms. Separate because a mutation's audited intent is not its intent: it records
  // the op and the field NAMES only. Going through these rather than through `allow`/`refuse` with
  // a hand-built intent is what stops one mutation refusal from auditing differently than the
  // identical one three lines below it.
  allowMutation(i: MutationIntent, grantId: string | null, fields: string[]): Promise<AuditedAllow>;
  refuseMutation(
    i: MutationIntent,
    grantId: string | null,
    reason: MutationRefusalReason,
  ): Promise<MutationResult>;
};

// Raised to abort a data transaction whose decision could not be recorded.
//
// `allow` inside `withOrg` is the one place returning the refusal is not enough: withOrg commits
// on a normal return, so the write would land with no audit row and the caller would be told
// internal_error — the worst of both. Throwing rolls the transaction back, and the verb's existing
// catch turns it into the same controlled refusal (and re-attempts the refusal's own audit row,
// which records that the operation was rejected).
export class AuditWriteFailed extends Error {
  constructor() {
    super("audit write failed — transaction rolled back");
  }
}

export function assertRecorded(rec: AuditedAllow): asserts rec is { ok: true; auditId: string } {
  if (!rec.ok) throw new AuditWriteFailed();
}

// A mutation's audit intent records the op and the field NAMES it touched — never the submitted
// values. This is a deliberate departure from query, whose intent is safe to store verbatim: a
// write payload can carry real personal data, and an audit row is readable by every admin in the UI.
function mutationIntent(i: MutationIntent, fields: string[]) {
  return { op: i.op, collection: i.collection, id: "id" in i ? i.id : undefined, fields };
}

export function makeAuditWriter(app: Pool, ctx: BrokerContext): AuditWriter {
  async function record(
    collection: string,
    outcome: "allowed" | "refused",
    reason: string | null,
    detail: AuditDetail,
  ): Promise<string | null> {
    try {
      return await writeAudit(app, {
        userId: ctx.userId,
        env: ctx.env,
        collection,
        orgId: ctx.orgId,
        intent: detail.intent ?? null,
        fieldsReturned: detail.fieldsReturned ?? [],
        unmaskedFields: detail.unmaskedFields ?? [],
        grantId: detail.grantId ?? null,
        outcome,
        reason,
        via: ctx.via,
      });
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
          orgId: ctx.orgId,
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

  // An allow is only an allow once the row exists. This is the whole of the downgrade rule.
  const sealed = (auditId: string | null): AuditedAllow =>
    auditId === null
      ? { ok: false, reason: "internal_error", auditId: null }
      : { ok: true, auditId };

  return {
    async allow(collection, detail = {}) {
      return sealed(await record(collection, "allowed", null, detail));
    },
    async refuse(collection, reason, detail = {}) {
      return { ok: false, reason, auditId: await record(collection, "refused", reason, detail) };
    },
    async allowMutation(i, grantId, fields) {
      return sealed(
        await record(i.collection, "allowed", null, { intent: mutationIntent(i, fields), grantId }),
      );
    },
    async refuseMutation(i, grantId, reason) {
      // The field names a refused mutation touched, taken from the intent itself. A delete carries
      // no values, so it names none.
      const fields = i.op === "delete" ? [] : Object.keys(i.values);
      const auditId = await record(i.collection, "refused", reason, {
        intent: mutationIntent(i, fields),
        grantId,
      });
      return { ok: false, reason, auditId };
    },
  };
}
