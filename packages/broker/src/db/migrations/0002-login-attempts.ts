// Migration 0002 — per-account failed-login tracking, for the credential lockout in
// apps/web/lib/lockout.ts.
//
// Keyed by lowercased email rather than by user id, so attempts against an account that does not
// exist are counted too. Counting only real accounts would make the lockout itself an enumeration
// oracle: the address that locks is the address that exists.
export const m0002LoginAttempts = {
  version: "0002_login_attempts",
  sql: `
create table if not exists app.login_attempts (
  email text primary key,
  failures int not null default 0,
  last_failure_at timestamptz,
  locked_until timestamptz);

create index if not exists login_attempts_locked_until
  on app.login_attempts (locked_until) where locked_until is not null;
`,
};
