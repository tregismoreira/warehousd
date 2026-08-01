import type { Pool } from "pg";
import { migrateApp } from "./migrate";

export const DEFAULT_ORG_ID = "default";

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
// (see apps/web/lib/auth.ts), including `orgId`. It emits them NOT NULL with the default
// applied in application code, not in DDL — so a direct SQL insert (a seeder, a test,
// an operator) would fail on a column it has no reason to know about. Push the default
// down to the column. Runs after `@better-auth/cli migrate`, hence the existence guard.
//
// Deliberately NOT a migration: it has to run after Better Auth's own migrator has created
// app."user", which happens after migrateApp. Inside the ledger it would either fail on a fresh
// database or record a version for work that silently no-opped.
export async function migrateUserOrg(db: Pool): Promise<void> {
  await db.query(`
    do $$ begin
      if to_regclass('app.user') is not null then
        alter table app."user" alter column "orgId" set default '${DEFAULT_ORG_ID}';
        update app."user" set "orgId" = '${DEFAULT_ORG_ID}' where "orgId" is null;
        if not exists (select 1 from pg_constraint where conname = 'user_org_fk') then
          alter table app."user" add constraint user_org_fk
            foreign key ("orgId") references app.organizations(id);
        end if;
      end if;
    end $$;`);
}
