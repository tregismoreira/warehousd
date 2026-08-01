// Migration 0001 — the app schema as it stood at 95d7e78, lifted verbatim from the pre-ledger
// createAppSchema(). Every statement is `if not exists`, `add column if not exists`, an
// idempotent grant, or a pg_constraint-guarded `add constraint`, so applying it to a database an
// older build already created is a no-op. That property is what lets an existing deploy adopt the
// ledger with no baseline step: 0001 runs once against a schema that already matches it, changes
// nothing, and records the version.
//
// Migrations 0002+ do NOT inherit that property and must be forward-only.
// NEVER edit this file once it has shipped — add a new migration instead.
//
// The one transformation from the original: addOrgColumn() was a helper called in a loop, so its
// four call sites are expanded here. All four passed literals, which is why the ident()/literal()
// quoting it used is unnecessary inside a static migration; the emitted SQL is identical.
export const m0001Init = {
  version: "0001_init",
  sql: `
create schema if not exists app;

create table if not exists app.organizations (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now());
insert into app.organizations (id, name) values ('default', 'Default')
  on conflict (id) do nothing;

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

-- Upgrade path for a stack provisioned before the org dimension existed. collections carries
-- org_id for symmetry only — collections are config-defined and global to the deployment in v1,
-- so it is not yet an isolation boundary there.
alter table app."collections" add column if not exists org_id text not null default 'default';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'collections_org_fk') then
    alter table app."collections" add constraint "collections_org_fk"
      foreign key (org_id) references app.organizations(id);
  end if;
end $$;

alter table app."grants" add column if not exists org_id text not null default 'default';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'grants_org_fk') then
    alter table app."grants" add constraint "grants_org_fk"
      foreign key (org_id) references app.organizations(id);
  end if;
end $$;

alter table app."audit_events" add column if not exists org_id text not null default 'default';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'audit_events_org_fk') then
    alter table app."audit_events" add constraint "audit_events_org_fk"
      foreign key (org_id) references app.organizations(id);
  end if;
end $$;

alter table app.grants add column if not exists document_filter jsonb;
alter table app.grants add column if not exists verbs text[] not null default '{read}';
alter table app.grants add column if not exists mode text not null default 'direct';

-- Backfill verbs to '{read}' for existing grants if they're still null (paranoia)
update app.grants set verbs='{read}' where verbs is null;

-- Enforce mode vocabulary
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'grants_mode_check') then
    alter table app.grants add constraint grants_mode_check
      check (mode in ('direct','proposal_only'));
  end if;
end $$;

drop index if exists grants_one_active;
create unique index if not exists grants_one_active
  on app.grants (org_id, user_id, collection, env) where status='approved';

-- Taxonomy: vocabularies (flat) + terms (single-level; parent_id reserved for hierarchy).
-- Terms are env-scoped: 'all' for YAML vocabularies, 'dev'/'live' for dataset-sourced ones.
-- See docs/architecture.md, "Taxonomies".
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

-- client_policies: per-OAuth-client env:live allow-list. No FK to Better Auth's oauth client
-- table: migrations run BEFORE the "@better-auth/cli migrate" step in both the container
-- entrypoint and the web test helper, so that table doesn't exist yet when this runs — the same
-- reason app.grants.user_id has no FK to Better Auth's user table.
create table if not exists app.client_policies (
  client_id text primary key,
  display_name text,
  org_id text not null default 'default',
  allowed_scopes text[] not null default '{env:dev}',
  promoted_at timestamptz,
  promoted_by text);

alter table app."client_policies" add column if not exists org_id text not null default 'default';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_policies_org_fk') then
    alter table app."client_policies" add constraint "client_policies_org_fk"
      foreign key (org_id) references app.organizations(id);
  end if;
end $$;

-- Collection ceiling (allowed_collections), credential type (mode), and per-mode config
alter table app.client_policies add column if not exists allowed_collections text[];
alter table app.client_policies add column if not exists mode text not null default 'delegated';
alter table app.client_policies add column if not exists robot_user_id text;
alter table app.client_policies add column if not exists trusted_issuer_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_policies_mode_check') then
    alter table app.client_policies add constraint client_policies_mode_check
      check (mode in ('delegated','headless'));
  end if;
end $$;

-- API key secrets: hashed for storage, never stored plaintext.
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

-- Trusted OIDC issuers for the delegated flow
create table if not exists app.trusted_issuers (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references app.organizations(id),
  issuer text not null,
  jwks_uri text not null,
  audience text not null,
  subject_claim text not null default 'sub',
  created_at timestamptz not null default now(),
  unique (org_id, issuer));

-- audit_events via column records which credential/auth path was used
alter table app.audit_events add column if not exists via text;

-- Secret read is needed to verify secrets; trusted_issuers for issuer config.
grant select on app.client_secrets, app.trusted_issuers to warehousd_dev, warehousd_live;

-- change_log tracks all mutations to data tables; seq is a global monotonic cursor.
-- _rev_seq is per-document and unsuitable for a feed cursor — gaps would cause the feed to skip
-- revisions under even mild concurrency. This table exists because seq order is not commit order:
-- under concurrency, seq can advance before an earlier tx commits, so readers polling seq > cursor
-- might miss committed rows. The feed mitigates this by capping results to entries committed
-- before the oldest in-flight tx (the standard snapshot isolation pattern).
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

-- audit_events is INSERT-only for data roles. This is the enforcement mechanism for invariant 7
-- (docs/architecture.md) and the audit-completeness assertions in docs/testing.md.
-- Do not loosen it in any later migration.
grant usage on schema app to warehousd_dev, warehousd_live;
grant select on app.grants, app.collections, app.vocabularies, app.terms to warehousd_dev, warehousd_live;
grant insert on app.audit_events to warehousd_dev, warehousd_live;
revoke update, delete on app.audit_events from warehousd_dev, warehousd_live;

-- Write roles can insert change log entries in the same transaction as revisions. They need
-- insert on the table, usage on the sequence (bigserial), and usage on the schema.
grant usage on schema app to warehousd_dev_write, warehousd_live_write;
grant insert on app.change_log to warehousd_dev_write, warehousd_live_write;
grant usage on sequence app.change_log_seq_seq to warehousd_dev_write, warehousd_live_write;
grant select on app.change_log to warehousd_dev, warehousd_live;
`,
};
