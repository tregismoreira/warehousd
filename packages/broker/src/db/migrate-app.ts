import type { Pool } from "pg";
import { migrateApp } from "./migrate";

export const DEFAULT_WORKSPACE_ID = "default";

export { migrateApp };

/**
 * @deprecated Use `migrateApp`.
 *
 * The DDL this used to hold is now migration 0001 (`./migrations/0001-init.ts`), applied through
 * the versioned runner. The name is kept because the broker suite calls it from many files, and
 * leaving it on the test path is deliberate: the alias is exercised on every run rather than
 * rotting unnoticed. New code must call `migrateApp`.
 */
export async function createAppSchema(db: Pool): Promise<void> {
  await migrateApp(db);
}

// Better Auth owns the `user` table and generates its columns from `additionalFields`
// (see apps/web/lib/auth.ts), including `workspaceId`. It emits them NOT NULL with the default
// applied in application code, not in DDL — so a direct SQL insert (a seeder, a test,
// an operator) would fail on a column it has no reason to know about. Push the default
// down to the column. Runs after `@better-auth/cli migrate`, hence the existence guard.
//
// Renaming `orgId` to `workspaceId` in `additionalFields` makes the Better Auth migrator ADD a
// new column rather than rename the old one — it only ever adds what is missing. A database
// whose `app.user` still carries `orgId` from before this rename therefore ends up with both
// columns after the CLI runs; the block below carries the value across and retires the old one,
// idempotently, before falling through to the same default/backfill/FK steps as always.
//
// Deliberately NOT a migration: it has to run after Better Auth's own migrator has created
// app."user", which happens after migrateApp. Inside the ledger it would either fail on a fresh
// database or record a version for work that silently no-opped.
//
// The membership backfill lives here for the same reason: `app.workspace_members` is created by
// migration 0009, but populating it from `app.user` needs that table, which does not exist until
// after this function's caller runs the Better Auth migrator. `on conflict do nothing` makes it
// safe to re-run — a user promoted or demoted after their first login keeps that role rather than
// being reset to whatever `app.user.role` says on the next boot.
export async function migrateUserWorkspace(db: Pool): Promise<void> {
  await db.query(`
    do $$ begin
      if to_regclass('app.user') is null then return; end if;
      -- Carry values over if the pre-rename column is still present, then retire it.
      if exists (select 1 from information_schema.columns
                 where table_schema='app' and table_name='user' and column_name='orgId') then
        if exists (select 1 from information_schema.columns
                   where table_schema='app' and table_name='user' and column_name='workspaceId') then
          update app."user" set "workspaceId" = "orgId" where "workspaceId" is null;
          alter table app."user" drop column "orgId";
        else
          alter table app."user" rename column "orgId" to "workspaceId";
        end if;
      end if;
      alter table app."user" alter column "workspaceId" set default '${DEFAULT_WORKSPACE_ID}';
      update app."user" set "workspaceId" = '${DEFAULT_WORKSPACE_ID}' where "workspaceId" is null;
      if not exists (select 1 from pg_constraint where conname = 'user_workspace_fk') then
        alter table app."user" add constraint user_workspace_fk
          foreign key ("workspaceId") references app.workspaces(id);
      end if;
      if to_regclass('app.workspace_members') is not null then
        insert into app.workspace_members (workspace_id, user_id, role)
          select "workspaceId", id, coalesce(role, 'member') from app."user"
          on conflict (workspace_id, user_id) do nothing;
      end if;
    end $$;`);
}
