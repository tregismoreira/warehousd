import { Pool } from "pg";

const ADMIN = "postgres://postgres:postgres@127.0.0.1:54330/postgres";
const BASE = "postgres://postgres:postgres@127.0.0.1:54330";

export type Provisioned = {
  dbName: string;
  urls: { admin: string; dev: string; live: string; imp: string; devWrite?: string; liveWrite?: string };
  end: () => Promise<void>;
};

// Provision a fresh database named after the caller. Roles:
//   warehousd_app      — owns app schema; NO privileges on data_live/data_synth
//   warehousd_dev      — privileges on data_synth ONLY
//   warehousd_live     — privileges on data_live ONLY
//   warehousd_import   — INSERT-only on data_live base tables; no SELECT, UPDATE, DELETE;
//                        no privileges on data_synth or app (imports never read real data)
//   warehousd_dev_write  — write privileges on data_synth base tables
//   warehousd_live_write — write privileges on data_live base tables
export async function provision(label: string): Promise<Provisioned> {
  const dbName = `wh_${label}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const admin = new Pool({ connectionString: ADMIN });
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const url = (u: string) => `postgres://${u}:pw@127.0.0.1:54330/${dbName}`;
  const db = new Pool({ connectionString: `${BASE}/${dbName}` });
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
      const a = new Pool({ connectionString: ADMIN });
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    },
  };
}
