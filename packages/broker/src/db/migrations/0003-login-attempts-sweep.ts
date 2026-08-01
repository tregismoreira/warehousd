// Migration 0003 — index the column the lockout sweep filters on.
//
// 0002 indexed `locked_until` (partially, where it is not null), which serves the "is this
// address locked right now" read. It does not serve the sweep: the rows that need collecting are
// the ones that never reached the lock threshold at all, so `locked_until` is null on every one
// of them and the partial index excludes exactly the wrong set.
export const m0003LoginAttemptsSweep = {
  version: "0003_login_attempts_sweep",
  sql: `
create index if not exists login_attempts_last_failure_at
  on app.login_attempts (last_failure_at);
`,
};
