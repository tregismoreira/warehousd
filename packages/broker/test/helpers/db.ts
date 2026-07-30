import { Pool } from "pg";
import { BASE, ADMIN, cloneName, cloneTemplate, templateName } from "./templates";

// Roles are cluster-global, so they outlive a cached template. bootstrap.test.ts rotates
// warehousd_dev's password and puts it back in a finally; a crash in between would otherwise
// leave every later run failing to authenticate. Re-assert them once at the start of each run.
export async function ensureRoles(): Promise<void> {
  const { ensureSchemasAndRoles } = await import("../../src/index");
  const db = new Pool({ connectionString: `${BASE}/${templateName("broker")}`, max: 1 });
  await ensureSchemasAndRoles(db, "pw");
  await db.end();
}

export type Provisioned = {
  dbName: string;
  urls: {
    admin: string;
    dev: string;
    live: string;
    imp: string;
    devWrite?: string;
    liveWrite?: string;
  };
  end: () => Promise<void>;
};

// Roles:
//   warehousd_app      — owns app schema; NO privileges on data_live/data_synth
//   warehousd_dev      — privileges on data_synth ONLY
//   warehousd_live     — privileges on data_live ONLY
//   warehousd_import   — INSERT-only on data_live base tables; no SELECT, UPDATE, DELETE;
//                        no privileges on data_synth or app (imports never read real data)
//   warehousd_dev_write  — write privileges on data_synth base tables
//   warehousd_live_write — write privileges on data_live base tables
//
// Roles are cluster-global, so they are created once here when the template is built rather
// than on every provision — which is also what lets test files run in parallel without racing
// each other's CREATE ROLE.
export async function bootstrapBrokerDb(appUrl: string): Promise<void> {
  const db = new Pool({ connectionString: appUrl, max: 1 });
  await db.query(`
    create schema app;
    create schema data_synth;
    create schema data_live;
    do $$ begin
      if not exists (select from pg_roles where rolname='warehousd_dev') then
        create role warehousd_dev login password 'pw'; end if;
      if not exists (select from pg_roles where rolname='warehousd_live') then
        create role warehousd_live login password 'pw'; end if;
      if not exists (select from pg_roles where rolname='warehousd_import') then
        create role warehousd_import login password 'pw'; end if;
      if not exists (select from pg_roles where rolname='warehousd_dev_write') then
        create role warehousd_dev_write login password 'pw'; end if;
      if not exists (select from pg_roles where rolname='warehousd_live_write') then
        create role warehousd_live_write login password 'pw'; end if;
    end $$;
    grant usage on schema data_synth to warehousd_dev;
    grant usage on schema data_live  to warehousd_live;
    grant usage on schema data_live to warehousd_import;
    grant usage on schema app to warehousd_dev, warehousd_live;
    grant usage on schema data_synth to warehousd_dev_write;
    grant usage on schema data_live to warehousd_live_write;
    grant usage on schema app to warehousd_dev_write, warehousd_live_write;
  `);
  await db.end();
}

// Provision a fresh database named after the caller, copied from the template globalSetup
// built. `bare` skips the template and hands back an empty database — for the tests that
// exercise the bootstrap itself and need a virgin cluster to run against.
export async function provision(
  label: string,
  opts: { bare?: boolean } = {},
): Promise<Provisioned> {
  const dbName = cloneName("wh", label);

  if (opts.bare) {
    const admin = new Pool({ connectionString: ADMIN, max: 1 });
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.query(`create database ${dbName}`);
    await admin.end();
  } else {
    await cloneTemplate("broker", dbName);
  }

  const url = (u: string) => `postgres://${u}:pw@127.0.0.1:54330/${dbName}`;
  return {
    dbName,
    urls: {
      admin: `${BASE}/${dbName}`,
      dev: url("warehousd_dev"),
      live: url("warehousd_live"),
      imp: url("warehousd_import"),
      devWrite: url("warehousd_dev_write"),
      liveWrite: url("warehousd_live_write"),
    },
    async end() {
      const a = new Pool({ connectionString: ADMIN, max: 1 });
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    },
  };
}
