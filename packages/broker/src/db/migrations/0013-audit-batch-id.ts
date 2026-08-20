// Migration 0013 — a shared id correlating the audit rows of one atomic batch decision.
//
// `decideProposals` (verbs/propose.ts) commits or rolls back a whole list of approve/reject
// decisions as one transaction, but non-negotiable 3 still requires one audit row per proposal —
// batching is a transaction boundary, not a reason to collapse N decisions into one row. What was
// missing was a way to ask "which rows belonged to the same batch", which `select * from
// app.audit_events where …` cannot answer from `intent` or `reason` alone.
//
// A column rather than a key inside `intent`, for the same reason `unmasked_fields` (0005),
// `principals` (0006) and `grant_principal` (0007) are columns: `intent` records the request a
// caller made, and batch identity is a property of the DECISION — assigned by the verb, not
// supplied by the caller, and the same for every row a single call produces. `principals` set the
// precedent: a fact about who decided, not about what was asked, gets its own column.
//
// Nullable, with no default: every decision made outside `decideProposals` (a lone query, a direct
// mutation, approveProposal/rejectProposal's own one-item batch included, since a single decision
// still runs through the same driver) has no batch to correlate with, and `null` says so rather
// than a sentinel a reader would have to learn is not a real batch.
//
// The partial index only covers non-null rows: every audit row before this migration, and every
// non-batch decision after it, would otherwise bloat an index that exists purely to make "give me
// this batch's rows" fast.
export const m0013AuditBatchId = {
  version: "0013_audit_batch_id",
  sql: `
alter table app.audit_events add column if not exists batch_id uuid;
create index if not exists audit_events_batch_id_idx on app.audit_events (batch_id) where batch_id is not null;
`,
};
