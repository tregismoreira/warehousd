import type { Pool } from "pg";
import { ident, literal } from "../sql/ident";

export const DEFAULT_ORG_ID = "default";

export async function createAppSchema(db: Pool): Promise<void> {
  await db.query(`create schema if not exists app`);
  await db.query(`
    create table if not exists app.organizations (
      id text primary key,
      name text not null,
      created_at timestamptz not null default now());
    insert into app.organizations (id, name) values ('default', 'Default')
      on conflict (id) do nothing;
  `);
  await db.query(`
    create table if not exists app.collections (
      name text primary key, description text, config jsonb,
      org_id text not null default 'default', updated_at timestamptz default now());
    create table if not exists app.grants (
      id uuid primary key default gen_random_uuid(),
      user_id text not null, collection text not null,
      purpose_label text, purpose_detail text, allowed_fields text[],
      org_id text not null default 'default',
      env text not null check (env in ('dev','live')),
      status text not null check (status in ('pending','approved','denied','revoked')),
      requested_at timestamptz default now(), decided_at timestamptz,
      decided_by text, expires_at timestamptz,
      document_filter jsonb,
      verbs text[] not null default '{read}',
      mode text not null default 'direct' check (mode in ('direct','proposal_only')));
    create table if not exists app.audit_events (
      id uuid primary key default gen_random_uuid(),
      at timestamptz default now(), user_id text, env text, collection text,
      org_id text not null default 'default',
      intent jsonb, fields_returned text[], grant_id uuid,
      outcome text, reason text);
  `);
  // Upgrade path for a stack provisioned before the org dimension existed. `collections`
  // carries org_id for symmetry only — collections are config-defined and global to the
  // deployment in v1, so it is not yet an isolation boundary there.
  for (const t of ["collections", "grants", "audit_events"]) await addOrgColumn(db, t);
  await db.query(`alter table app.grants add column if not exists document_filter jsonb`);
  await db.query(
    `alter table app.grants add column if not exists verbs text[] not null default '{read}'`,
  );
  await db.query(
    `alter table app.grants add column if not exists mode text not null default 'direct'`,
  );
  // Backfill verbs to '{read}' for existing grants if they're still null (paranoia)
  await db.query(`update app.grants set verbs='{read}' where verbs is null`);
  // Enforce mode vocabulary
  await db.query(`
    do $$ begin
      if not exists (select 1 from pg_constraint where conname = 'grants_mode_check') then
        alter table app.grants add constraint grants_mode_check
          check (mode in ('direct','proposal_only'));
      end if;
    end $$;`);
  await db.query(`drop index if exists grants_one_active`);
  await db.query(`create unique index if not exists grants_one_active
    on app.grants (org_id, user_id, collection, env) where status='approved'`);
  // Taxonomy: vocabularies (flat) + terms (single-level; parent_id reserved for hierarchy — §5.6-adjacent design 2026-07-22)
  // Terms are env-scoped: 'all' for YAML vocabularies, 'dev'/'live' for dataset-sourced vocabularies.
  await db.query(`
    create table if not exists app.vocabularies (
      id uuid primary key default gen_random_uuid(),
      slug text not null unique,
      label text not null);
    create table if not exists app.terms (
      id uuid primary key default gen_random_uuid(),
      vocabulary_id uuid not null references app.vocabularies(id) on delete cascade,
      env text not null default 'all' check (env in ('all','dev','live')),
      slug text not null,
      label text not null,
      parent_id uuid references app.terms(id),
      unique (vocabulary_id, env, slug));
  `);
  // client_policies: per-OAuth-client env:live allow-list (§6.1). No FK to Better Auth's
  // oauth client table: createAppSchema runs BEFORE the `@better-auth/cli migrate` step in
  // both scripts/dev-bootstrap.ts and the web test helper, so that table doesn't exist yet
  // when this runs — same reason app.grants.user_id has no FK to Better Auth's user table.
  await db.query(`
    create table if not exists app.client_policies (
      client_id text primary key,
      display_name text,
      org_id text not null default 'default',
      allowed_scopes text[] not null default '{env:dev}',
      promoted_at timestamptz,
      promoted_by text);
  `);
  await addOrgColumn(db, "client_policies");
  // Phase 7: collection ceiling (allowed_collections), credential type (mode), and per-mode config
  await db.query(
    `alter table app.client_policies add column if not exists allowed_collections text[]`,
  );
  await db.query(
    `alter table app.client_policies add column if not exists mode text not null default 'delegated'`,
  );
  await db.query(`alter table app.client_policies add column if not exists robot_user_id text`);
  await db.query(`alter table app.client_policies add column if not exists trusted_issuer_id uuid`);
  await db.query(`
    do $$ begin
      if not exists (select 1 from pg_constraint where conname = 'client_policies_mode_check') then
        alter table app.client_policies add constraint client_policies_mode_check
          check (mode in ('delegated','headless'));
      end if;
    end $$;`);
  // API key secrets: hashed for storage, never stored plaintext.
  await db.query(`
    create table if not exists app.client_secrets (
      id uuid primary key default gen_random_uuid(),
      client_id text not null references app.client_policies(client_id) on delete cascade,
      org_id text not null references app.organizations(id),
      prefix text not null,
      secret_hash text not null,
      created_at timestamptz not null default now(),
      created_by text not null,
      expires_at timestamptz not null,
      last_used_at timestamptz,
      revoked_at timestamptz);
    create index if not exists client_secrets_prefix_idx on app.client_secrets (prefix);
  `);
  // Trusted OIDC issuers for the delegated flow
  await db.query(`
    create table if not exists app.trusted_issuers (
      id uuid primary key default gen_random_uuid(),
      org_id text not null references app.organizations(id),
      issuer text not null,
      jwks_uri text not null,
      audience text not null,
      subject_claim text not null default 'sub',
      created_at timestamptz not null default now(),
      unique (org_id, issuer));
  `);
  // Phase 7: audit_events via column to record which credential/auth path was used
  await db.query(`alter table app.audit_events add column if not exists via text`);
  // Grant secret read on app.client_secrets read (needed to verify secrets), and trusted_issuers for issuer config
  await db.query(`
    grant select on app.client_secrets, app.trusted_issuers to warehousd_dev, warehousd_live;
  `);
  // change_log tracks all mutations to data tables (§6); seq is a global monotonic cursor.
  // _rev_seq is per-document and unsuitable for a feed cursor — gaps would cause the feed
  // to skip revisions under even mild concurrency. This table exists because seq order is not
  // commit order: under concurrency, seq can advance before an earlier tx commits, so readers
  // polling seq > cursor might miss committed rows. The feed mitigates this by capping results
  // to entries committed before the oldest in-flight tx (the standard snapshot isolation pattern).
  await db.query(`
    create table if not exists app.change_log (
      seq         bigserial primary key,
      org_id      text        not null references app.organizations(id),
      env         text        not null check (env in ('dev','live')),
      collection  text        not null,
      document_id text        not null,
      rev         uuid        not null,
      op          text        not null,
      status      text        not null,
      at          timestamptz not null default now(),
      by          text        not null);
    create index if not exists change_log_org_env_seq_idx
      on app.change_log (org_id, env, seq);
  `);
  // audit_events is INSERT-only for data roles (§5.5 / test 9)
  await db.query(`
    grant usage on schema app to warehousd_dev, warehousd_live;
    grant select on app.grants, app.collections, app.vocabularies, app.terms to warehousd_dev, warehousd_live;
    grant insert on app.audit_events to warehousd_dev, warehousd_live;
    revoke update, delete on app.audit_events from warehousd_dev, warehousd_live;
  `);
  // Write roles can insert change log entries in the same transaction as revisions.
  // They need insert on the table, usage on the sequence (bigserial), and usage on the schema.
  await db.query(`
    grant usage on schema app to warehousd_dev_write, warehousd_live_write;
    grant insert on app.change_log to warehousd_dev_write, warehousd_live_write;
    grant usage on sequence app.change_log_seq_seq to warehousd_dev_write, warehousd_live_write;
    grant select on app.change_log to warehousd_dev, warehousd_live;
  `);
}

// `add constraint` has no `if not exists` form, so re-running createAppSchema would fail on
// the second pass. Checking pg_constraint keeps the whole function idempotent, which the
// entrypoint relies on: it runs on every boot.
//
// The table name and the org default are interpolated because neither can be a bound parameter in
// DDL, so both go through the shared quoting helpers. All three call sites pass literals, which is
// why this was never reachable — but it was the one place in the codebase building SQL text around
// a name without validating it, and "the callers happen to be literals" is a property of today's
// callers rather than of this function.
async function addOrgColumn(db: Pool, table: string): Promise<void> {
  const t = ident(table);
  const fk = `${table}_org_fk`;
  await db.query(
    `alter table app.${t} add column if not exists org_id text not null default ${literal(DEFAULT_ORG_ID)}`,
  );
  await db.query(`
    do $$ begin
      if not exists (select 1 from pg_constraint where conname = ${literal(fk)}) then
        alter table app.${t} add constraint ${ident(fk)}
          foreign key (org_id) references app.organizations(id);
      end if;
    end $$;`);
}

// Better Auth owns the `user` table and generates its columns from `additionalFields`
// (see apps/web/lib/auth.ts), including `orgId`. It emits them NOT NULL with the default
// applied in application code, not in DDL — so a direct SQL insert (a seeder, a test,
// an operator) would fail on a column it has no reason to know about. Push the default
// down to the column. Runs after `@better-auth/cli migrate`, hence the existence guard.
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
