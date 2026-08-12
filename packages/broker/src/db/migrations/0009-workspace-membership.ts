// Migration 0009 — workspace membership: a user's role becomes per-workspace, not global.
//
// `app.user.role` was a scalar column, so an admin was an admin everywhere. This table is the
// membership and role for one (workspace, user) pair. No FK on `user_id` — migrations run before
// the Better Auth migrator creates `app.user`, the same reason `app.grants.user_id` has none
// (see 0001-init.ts).
//
// Backfill cannot live here for the same reason: it reads `app.user`, which does not exist yet
// when this runs. It lives in `migrateUserWorkspace` (db/migrate-app.ts), after the column
// fix-up, so it runs once the Better Auth table exists.
export const m0009WorkspaceMembership = {
  version: "0009_workspace_membership",
  sql: `
create table if not exists app.workspace_members (
  workspace_id text not null references app.workspaces(id) on delete cascade,
  user_id      text not null,
  role         text not null default 'member' check (role in ('admin','manager','member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id));
create index if not exists workspace_members_user_idx on app.workspace_members (user_id);
grant select on app.workspace_members to warehousd_dev, warehousd_live;
`,
};
