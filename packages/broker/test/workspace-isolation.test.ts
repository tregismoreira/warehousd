import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, DEFAULT_WORKSPACE_ID } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, withWorkspace, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { buildSelect } from "../src/sql/build";
import type { WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { ConfigSchema } from "../src/config/schema";

import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// Every dataset table carries NOT NULL revision bookkeeping, so a fixture insert has to
// be a well-formed `create` revision. These are literals; every value stays bound.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  synthetic: { documents_per_collection: {} },
  taxonomies: {},
  demo: false,
  collections: {
    people: {
      description: "dir",
      type: "dataset",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        full_name: { type: "text", posture: "allow" },
      },
    },
  },
});

const WORKSPACE_A = DEFAULT_WORKSPACE_ID;
const WORKSPACE_B = "workspace-b";

let p: Provisioned;
let admin: Pool;
let pools: Pools;
let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("orgiso");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await admin.query(`insert into app.workspaces (id, name) values ($1,'B')`, [WORKSPACE_B]);
  await applyConfig(admin, cfg);

  // Two documents that differ only by workspace. The broker never names workspace_id, so anything that
  // separates these two rows has to be the database.
  await admin.query(
    `insert into data_synth.people (${R}, workspace_id, id, full_name) values
       (${RV}, $1, gen_random_uuid(), 'Ana of A'), (${RV}, $2, gen_random_uuid(), 'Bo of B')`,
    [WORKSPACE_A, WORKSPACE_B],
  );
  for (const workspace of [WORKSPACE_A, WORKSPACE_B])
    await admin.query(
      `insert into app.grants (workspace_id,user_id,collection,allowed_fields,env,status)
       values ($1,'shared','people', array['id','full_name'],'dev','approved')`,
      [workspace],
    );

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
}, 60_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

describe("workspace isolation", () => {
  it("a query in workspace A returns only workspace A's documents", async () => {
    const r = await broker.query(makeCtx({ userId: "shared", workspaceId: WORKSPACE_A }), {
      collection: "people",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.map((d) => d.full_name)).toEqual(["Ana of A"]);
  });

  it("the same user in workspace B sees only workspace B's documents", async () => {
    const r = await broker.query(makeCtx({ userId: "shared", workspaceId: WORKSPACE_B }), {
      collection: "people",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.map((d) => d.full_name)).toEqual(["Bo of B"]);
  });

  it("the database is what refuses — the broker's SQL carries no workspace predicate", async () => {
    const { text, values } = buildSelect(
      "dev",
      { collection: "people", fields: ["id", "full_name"] },
      ["id", "full_name"],
    );
    expect(text).not.toMatch(/workspace_id/);

    const dev = testPool({ connectionString: p.urls.dev });
    // That exact statement, run with each workspace in scope, still separates the two rows.
    const a = await withWorkspace(dev, WORKSPACE_A, (c) => c.query(text, values));
    const b = await withWorkspace(dev, WORKSPACE_B, (c) => c.query(text, values));
    await dev.end();
    expect(a.rows.map((r) => r.full_name)).toEqual(["Ana of A"]);
    expect(b.rows.map((r) => r.full_name)).toEqual(["Bo of B"]);
  });

  it("with no workspace in scope the view returns nothing — the wall fails closed", async () => {
    const dev = testPool({ connectionString: p.urls.dev });
    const r = await dev.query(`select full_name from data_synth.v_people`);
    await dev.end();
    expect(r.rowCount).toBe(0);
  });

  it("a grant belongs to one workspace: workspace C sees no grant at all", async () => {
    await admin.query(`insert into app.workspaces (id, name) values ('workspace-c','C')`);
    const r = await broker.query(makeCtx({ userId: "shared", workspaceId: "workspace-c" }), {
      collection: "people",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_grant");
  });

  it("RLS is enabled with a workspace_isolation policy on every data table", async () => {
    // Scoped to the data schemas: migration 0012 gave the control-plane app.* tables their own
    // workspace_isolation policies (see workspace-control-plane.test.ts and
    // apps/web/test/control-plane-isolation.integration.test.ts), and this test's claim is about
    // the data plane specifically — an unscoped query would pick up both and conflate them.
    const r = await admin.query(
      `select schemaname, tablename from pg_policies
       where policyname='workspace_isolation' and schemaname in ('data_synth','data_live')
       order by schemaname`,
    );
    // `_acl` is in the list for the same reason `people` is: it is a data table holding per-workspace
    // rows, and the read roles never touch it directly — but the write roles do, and RLS is their
    // wall. The view's own join carries `acl.workspace_id = base.workspace_id` explicitly; neither is
    // redundant. See rlsDDL/aclTableDDL in apply/ddl.ts.
    expect(r.rows.map((x) => `${x.schemaname}.${x.tablename}`)).toEqual([
      "data_live._acl",
      "data_live.people",
      "data_synth._acl",
      "data_synth.people",
    ]);
    const rls = await admin.query(
      `select relrowsecurity from pg_class where relname='people' and relnamespace='data_synth'::regnamespace`,
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });

  it("audit rows carry the workspace the call was made in", async () => {
    const r = await broker.query(makeCtx({ userId: "shared", workspaceId: WORKSPACE_B }), {
      collection: "people",
    });
    const a = await admin.query(`select workspace_id from app.audit_events where id=$1`, [
      r.auditId,
    ]);
    expect(a.rows[0].workspace_id).toBe(WORKSPACE_B);
  });
});
