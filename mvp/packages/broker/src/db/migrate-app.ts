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
  // audit_events is INSERT-only for data roles (§5.5 / test 9)
  await db.query(`
    grant usage on schema app to warehousd_dev, warehousd_live;
    grant select on app.grants, app.collections to warehousd_dev, warehousd_live;
    grant insert on app.audit_events to warehousd_dev, warehousd_live;
    revoke update, delete on app.audit_events from warehousd_dev, warehousd_live;
  `);
}
