// Migration 0011 — platform keys: the credential the provisioning API (`/v1/platform/*`)
// authenticates with. A bearer secret, not a session and not an OAuth client — see
// apps/web/lib/platform-context.ts, the fourth and last auth boundary.
//
// `managed_workspaces text[]` is the ACL: null means every workspace (the operator's own
// bootstrap key, minted by `warehousd platform-key create --all-workspaces`); a non-null array
// means only those ids. Two consuming apps on one deployment must not be able to enumerate or
// delete each other's tenants through a key meant for one of them.
//
// No FK from managed_workspaces to app.workspaces(id): it is an array, Postgres has no per-element
// FK, and a workspace named in it that is later deleted should leave the key merely unable to
// reach anything by that id — not break the key itself.
//
// Data roles get no grant here, matching client_secrets and every other credential table: this is
// reached only through the app pool, from the platform routes and the CLI's own admin connection.
export const m0011PlatformKeys = {
  version: "0011_platform_keys",
  sql: `
create table if not exists app.platform_keys (
  id                 uuid primary key default gen_random_uuid(),
  label              text not null,
  prefix             text not null,
  secret_hash        text not null,
  managed_workspaces text[],
  created_at         timestamptz not null default now(),
  created_by         text not null,
  expires_at         timestamptz not null,
  last_used_at       timestamptz,
  revoked_at         timestamptz);
create index if not exists platform_keys_prefix_idx on app.platform_keys (prefix);

alter table app.workspaces add column if not exists created_by_key uuid references app.platform_keys(id);
alter table app.workspaces add column if not exists created_at timestamptz not null default now();

-- DELETE /v1/platform/workspaces/{id} (platform-context.ts) is the first thing that ever deletes
-- a row from this table, and three FKs from 0001-init.ts were never built for that: none carries
-- ON DELETE CASCADE, so a workspace with so much as one grant, client policy, or audit row would
-- fail the delete outright.
--
-- audit_events is different in kind, not just missing a clause. It is append-only and unprunable
-- by the application on purpose (docs/architecture.md, "Pruning is a superuser action") — letting
-- a workspace's deletion cascade into its own trail would let an admin erase what a workspace did
-- by deleting the workspace, which is exactly the erasure that rule exists to prevent. The FK is
-- dropped, not cascaded: a deleted workspace's audit rows survive it, naming an id nothing else
-- references any more, the same way a row can already name a deleted user or collection (neither
-- of those columns is FK'd either — see audit_events' definition in 0001-init.ts).
--
-- grants and client_policies are current-state access configuration with no reason to outlive the
-- workspace — cascading them is what makes "delete the tenant" actually delete it. collections is
-- config-defined and global to the deployment (0001-init.ts's own comment on workspace_id there),
-- so its workspace_id is always 'default' in practice; cascaded here anyway for consistency.
alter table app.audit_events drop constraint if exists audit_events_workspace_fk;

alter table app.grants drop constraint if exists grants_workspace_fk;
alter table app.grants add constraint grants_workspace_fk
  foreign key (workspace_id) references app.workspaces(id) on delete cascade;

alter table app.client_policies drop constraint if exists client_policies_workspace_fk;
alter table app.client_policies add constraint client_policies_workspace_fk
  foreign key (workspace_id) references app.workspaces(id) on delete cascade;

alter table app.collections drop constraint if exists collections_workspace_fk;
alter table app.collections add constraint collections_workspace_fk
  foreign key (workspace_id) references app.workspaces(id) on delete cascade;
`,
};
