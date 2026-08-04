// Migration 0005 — which of a grant's fields are carried RAW rather than masked.
//
// `allowed_fields` says what the grant can read. It cannot also say how much of each: a field
// with `posture: { read: mask }` is readable by anyone the grant covers, but only as its
// transform — and the whole point of the `unmask: allow` axis is that raw is a separate,
// narrower thing a manager has to approve on purpose.
//
// Default '{}' rather than nullable: absent must mean "nothing is unmasked", and a null column
// would make `not in (...)` behave differently from an empty list at exactly the moment it
// matters. NOT NULL says it once instead of at every read.
//
// Every entry is re-checked against the config at approve time (grants/manage.ts): a field can
// only appear here if its posture declares `unmask: allow`, so a row edited directly in the
// database still cannot widen a mask the YAML never offered to widen.
// The audit side is the same fact one step later: `fields_returned` says which fields a decision
// returned, and for a masked field that is no longer the whole answer. "Who read ssn" and "who
// read ssn unmasked" are different questions, and only the second one is the interesting one.
// It goes in its own column rather than inside the intent JSON because it is a property of the
// DECISION, not of what the caller asked for.
export const m0005GrantUnmaskedFields = {
  version: "0005_grant_unmasked_fields",
  sql: `
alter table app.grants
  add column if not exists unmasked_fields text[] not null default '{}';
alter table app.audit_events
  add column if not exists unmasked_fields text[] not null default '{}';
`,
};
