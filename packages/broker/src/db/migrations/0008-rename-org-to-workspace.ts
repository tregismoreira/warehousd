// Migration 0008 — rename the org dimension to workspace, everywhere the ledger owns it.
//
// Migrations 0001-0007 still say `org_id` / `app.organizations` / `org_isolation`, and must
// keep saying so forever: they already ran, on any database that bootstrapped before this one
// shipped, under those names, and the ledger records versions, not contents (see 0001-init.ts's
// header). This migration is the only place the rename happens. Every statement below is
// idempotent — guarded by `to_regclass`/`information_schema`/`pg_constraint` — so it is a no-op
// on a database that already carries the new names, which is what lets a *fresh* bootstrap run
// 0001-0007 (creating the org-named objects) immediately followed by this one (renaming them) and
// land in the same place as an upgraded existing database.
export const m0008RenameOrgToWorkspace = {
  version: "0008_rename_org_to_workspace",
  sql: `
-- Table first: every FK below names it.
do $$ begin
  if to_regclass('app.organizations') is not null and to_regclass('app.workspaces') is null then
    alter table app.organizations rename to workspaces;
  end if;
end $$;

-- Columns. Guarded individually so a partially-applied run is resumable.
do $$
declare t text;
begin
  foreach t in array array['collections','grants','audit_events','client_policies',
                           'client_secrets','trusted_issuers','change_log','user_groups']
  loop
    if exists (select 1 from information_schema.columns
               where table_schema='app' and table_name=t and column_name='org_id') then
      execute format('alter table app.%I rename column org_id to workspace_id', t);
    end if;
  end loop;
end $$;

-- Constraint and index names, for greppability. Renames only; nothing structural.
do $$
declare c record;
begin
  for c in select conname, conrelid::regclass::text as tbl from pg_constraint
           where conname like '%\\_org\\_fk' loop
    execute format('alter table %s rename constraint %I to %I',
                   c.tbl, c.conname, replace(c.conname, '_org_fk', '_workspace_fk'));
  end loop;
end $$;
`,
};
