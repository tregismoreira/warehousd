// Migration 0012 — RLS on the control-plane tables, the same wall the data plane has had since
// `rlsDDL` (apply/ddl.ts): `alter table ... enable row level security` plus a `workspace_isolation`
// policy keyed on `current_setting('warehousd.workspace_id', true)`.
//
// Every route that reaches these tables today does so through `pools.app` (apps/web/lib/broker.ts's
// `getAppPool`), connected as the schema owner — and Postgres does not apply RLS to a table's owner,
// with or without a policy, unless `FORCE ROW LEVEL SECURITY` is set (never is, here). So for that
// connection this migration is formalization, not a new wall: the real protection for `getAppPool()`
// routes remains the explicit `workspace_id = $1` predicate every query has to carry, the same
// lesson PR 4 drew for the data plane's own superuser-bypass finding. What this migration actually
// closes is narrower and real: `warehousd_dev` and `warehousd_live` hold standing SELECT (`grants`,
// `workspace_members`) or INSERT (`audit_events`, via client_secrets/trusted_issuers) grants on
// several of these tables from 0001-init.ts, granted for a direct-connection path nothing in the
// broker currently exercises (every verb reaches them through `pools.app` instead, per
// `verbs/deps.ts`). If that ever changes, or a bug reaches one of these tables through the wrong
// pool, RLS is the wall that catches it rather than the query's own predicate.
//
// `app.platform_keys` and `app.workspaces` are deliberately excluded: a platform key is the
// credential a caller presents to manage workspaces, not a row scoped to one, and `app.workspaces`
// is the tenant registry itself — neither carries a `workspace_id` column to police.
//
// `app.audit_events` gets two narrower policies instead of the other seven's single `for all`.
// Its own migration 0001 comment is explicit — "audit_events is INSERT-only for data roles... Do
// not loosen it in any later migration" — and `audit.test.ts`'s test 9 asserts the INSERT grant
// works with no workspace GUC set at all, matching how the append-only trail is meant to accept a
// row from any caller holding the grant. Enabling RLS with only a SELECT policy still denies every
// INSERT by default — Postgres denies a command with no applicable policy, it does not fall open —
// so the second policy exists purely to keep that grant exactly as unconstrained as it already
// was; `with check (true)` performs no workspace check at all. Both gaps were caught by test 9
// itself the first two times this migration's shape changed.
export const m0012ControlPlaneRls = {
  version: "0012_control_plane_rls",
  sql: `
do $$
declare t text;
begin
  foreach t in array array['grants','client_policies','client_secrets',
                           'trusted_issuers','user_groups','change_log','workspace_members']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists workspace_isolation on app.%I', t);
    execute format(
      'create policy workspace_isolation on app.%I
         using (workspace_id = current_setting(''warehousd.workspace_id'', true))
         with check (workspace_id = current_setting(''warehousd.workspace_id'', true))', t);
  end loop;
end $$;

alter table app.audit_events enable row level security;
drop policy if exists workspace_isolation on app.audit_events;
drop policy if exists workspace_isolation_insert on app.audit_events;
create policy workspace_isolation on app.audit_events
  for select
  using (workspace_id = current_setting('warehousd.workspace_id', true));
create policy workspace_isolation_insert on app.audit_events
  for insert
  with check (true);
`,
};
