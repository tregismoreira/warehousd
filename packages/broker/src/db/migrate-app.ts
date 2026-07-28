import type { Pool } from "pg";

export async function createAppSchema(db: Pool): Promise<void> {
  await db.query(`create schema if not exists app`);
  await db.query(`
    create table if not exists app.collections (
      name text primary key, description text, config jsonb,
      updated_at timestamptz default now());
    create table if not exists app.grants (
      id uuid primary key default gen_random_uuid(),
      user_id text not null, collection text not null,
      purpose_label text, purpose_detail text, allowed_fields text[],
      env text not null check (env in ('dev','live')),
      status text not null check (status in ('pending','approved','denied','revoked')),
      requested_at timestamptz default now(), decided_at timestamptz,
      decided_by text, expires_at timestamptz);
    create table if not exists app.audit_events (
      id uuid primary key default gen_random_uuid(),
      at timestamptz default now(), user_id text, env text, collection text,
      intent jsonb, fields_returned text[], grant_id uuid,
      outcome text, reason text);
  `);
  await db.query(`
    alter table app.grants add column if not exists document_filter jsonb;
    create unique index if not exists grants_one_active
      on app.grants (user_id, collection, env) where status='approved';
  `);
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
      allowed_scopes text[] not null default '{env:dev}',
      promoted_at timestamptz,
      promoted_by text);
  `);
  // audit_events is INSERT-only for data roles (§5.5 / test 9)
  await db.query(`
    grant usage on schema app to warehousd_dev, warehousd_live;
    grant select on app.grants, app.collections, app.vocabularies, app.terms to warehousd_dev, warehousd_live;
    grant insert on app.audit_events to warehousd_dev, warehousd_live;
    revoke update, delete on app.audit_events from warehousd_dev, warehousd_live;
  `);
}
