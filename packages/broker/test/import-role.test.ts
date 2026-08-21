import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import {
  createAppSchema,
  applyConfig,
  withWorkspace,
  SEED_REV_COLUMNS,
  SEED_REV_VALUES,
} from "../src/index";
import { loadConfig } from "../src/config/load";

let p: Provisioned, admin: Pool, imp: Pool;
const cfg = loadConfig(new URL("../../../examples/harbor", import.meta.url).pathname);

beforeAll(async () => {
  p = await provision("importrole");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  imp = testPool({ connectionString: p.urls.imp });
}, 60_000);
afterAll(async () => {
  await admin.end();
  await imp.end();
  await p.end();
});

// The import role writes base tables directly, so RLS — not the view predicate — is what
// confines it to one workspace. Every insert therefore has to declare the workspace it is writing into,
// and the policy's WITH CHECK refuses a mismatch. `withWorkspace` is how the real import path does it.
const asWorkspace = (workspaceId: string, sql: string, params: unknown[] = []) =>
  withWorkspace(imp, workspaceId, (c) => c.query(sql, params));

// Every dataset is revisioned, so a bare insert has to fill the NOT NULL bookkeeping columns.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

// The import role gained SELECT and a column-scoped UPDATE when import gained upsert and delete.
// It did NOT gain the ability to change or destroy stored data, and that distinction is the whole
// of the "immutability by privilege" claim — so it is asserted against Postgres rather than
// against the code that is supposed to respect it. If these pass while import/run.ts is rewritten
// to do something reckless, Postgres still refuses.
describe("warehousd_import privileges", () => {
  it("can INSERT into a data_live base table", async () => {
    await expect(
      asWorkspace(
        "default",
        `insert into data_live.departments (${R}, workspace_id, id, name)
         values (${RV}, 'default', gen_random_uuid(), 'Imported')`,
      ),
    ).resolves.toBeDefined();
  });

  it("cannot INSERT a row belonging to another workspace — RLS refuses, not the broker", async () => {
    await expect(
      asWorkspace(
        "default",
        `insert into data_live.departments (${R}, workspace_id, id, name)
         values (${RV}, 'other', gen_random_uuid(), 'Smuggled')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("can SELECT a data_live base table — upsert has to find the revision it supersedes", async () => {
    await expect(
      asWorkspace("default", `select 1 from data_live.departments limit 1`),
    ).resolves.toBeDefined();
  });

  it("still cannot SELECT the live view — it reads base tables or nothing", async () => {
    await expect(imp.query(`select * from data_live.v_people`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("cannot UPDATE a data column — a correction is a new revision, never a rewrite", async () => {
    // The privilege is `update (_current, _rev_status)`, so naming any other column is refused
    // by the grant itself. This is the assertion that stops an import silently overwriting real
    // data: there is no code path to it, because there is no privilege for it.
    await expect(
      asWorkspace("default", `update data_live.departments set name='x'`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asWorkspace("default", `update data_live.people set home_address='x'`),
    ).rejects.toThrow(/permission denied/i);
    // Even alongside a column it IS allowed to set.
    await expect(
      asWorkspace("default", `update data_live.departments set _current=false, name='x'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("can UPDATE only the two promotion columns", async () => {
    await expect(
      asWorkspace("default", `update data_live.departments set _current=_current`),
    ).resolves.toBeDefined();
    await expect(
      asWorkspace("default", `update data_live.departments set _rev_status=_rev_status`),
    ).resolves.toBeDefined();
  });

  it("cannot DELETE, ever — a delete import is a tombstone revision", async () => {
    await expect(asWorkspace("default", `delete from data_live.departments`)).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asWorkspace("default", `delete from data_live.people`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("cannot TRUNCATE either — the blunter way to lose everything", async () => {
    await expect(asWorkspace("default", `truncate data_live.departments`)).rejects.toThrow(
      /permission denied|must be owner/i,
    );
  });

  it("has no privileges at all on data_synth", async () => {
    await expect(imp.query(`select * from data_synth.people`)).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      imp.query(
        `insert into data_synth.departments (${R}, id, name) values (${RV}, gen_random_uuid(), 'x')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot read app.grants — it is not a decision-making role", async () => {
    await expect(imp.query(`select * from app.grants`)).rejects.toThrow(/permission denied/i);
  });

  it("cannot write its own change feed entry", async () => {
    // The import path writes app.change_log through the APP pool after its transaction commits,
    // precisely because this fails. The writer of data is not the writer of its own trail.
    await expect(
      imp.query(
        `insert into app.change_log (workspace_id, env, collection, document_id, rev, op, status, by)
         values ('default','live','departments','x','y','create','approved','imp')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("can insert multiple rows into the same table sequentially", async () => {
    await expect(
      asWorkspace(
        "default",
        `insert into data_live.departments (${R}, workspace_id, id, name)
         values (${RV}, 'default', gen_random_uuid(), 'Sales')`,
      ),
    ).resolves.toBeDefined();
    await expect(
      asWorkspace(
        "default",
        `insert into data_live.departments (${R}, workspace_id, id, name)
         values (${RV}, 'default', gen_random_uuid(), 'Engineering')`,
      ),
    ).resolves.toBeDefined();
  });
});

describe("the read roles gain nothing", () => {
  it("warehousd_live still cannot write", async () => {
    const live = testPool({ connectionString: p.urls.live });
    await expect(
      live.query(
        `insert into data_live.departments (${R}, id, name) values (${RV}, gen_random_uuid(), 'x')`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await live.end();
  });

  it("warehousd_dev still cannot see data_live", async () => {
    const dev = testPool({ connectionString: p.urls.dev });
    await expect(dev.query(`select * from data_live.v_people`)).rejects.toThrow(
      /permission denied/i,
    );
    await dev.end();
  });
});
