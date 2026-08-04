import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, DEFAULT_ORG_ID } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, withOrg, type Pools } from "../src/db/pools";
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

const ORG_A = DEFAULT_ORG_ID;
const ORG_B = "org-b";

let p: Provisioned;
let admin: Pool;
let pools: Pools;
let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("orgiso");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await admin.query(`insert into app.organizations (id, name) values ($1,'B')`, [ORG_B]);
  await applyConfig(admin, cfg);

  // Two documents that differ only by org. The broker never names org_id, so anything that
  // separates these two rows has to be the database.
  await admin.query(
    `insert into data_synth.people (${R}, org_id, id, full_name) values
       (${RV}, $1, gen_random_uuid(), 'Ana of A'), (${RV}, $2, gen_random_uuid(), 'Bo of B')`,
    [ORG_A, ORG_B],
  );
  for (const org of [ORG_A, ORG_B])
    await admin.query(
      `insert into app.grants (org_id,user_id,collection,allowed_fields,env,status)
       values ($1,'shared','people', array['id','full_name'],'dev','approved')`,
      [org],
    );

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
}, 60_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

describe("org isolation", () => {
  it("a query in org A returns only org A's documents", async () => {
    const r = await broker.query(makeCtx({ userId: "shared", orgId: ORG_A }), {
      collection: "people",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.map((d) => d.full_name)).toEqual(["Ana of A"]);
  });

  it("the same user in org B sees only org B's documents", async () => {
    const r = await broker.query(makeCtx({ userId: "shared", orgId: ORG_B }), {
      collection: "people",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.map((d) => d.full_name)).toEqual(["Bo of B"]);
  });

  it("the database is what refuses — the broker's SQL carries no org predicate", async () => {
    const { text, values } = buildSelect(
      "dev",
      { collection: "people", fields: ["id", "full_name"] },
      ["id", "full_name"],
    );
    expect(text).not.toMatch(/org_id/);

    const dev = new Pool({ connectionString: p.urls.dev });
    // That exact statement, run with each org in scope, still separates the two rows.
    const a = await withOrg(dev, ORG_A, (c) => c.query(text, values));
    const b = await withOrg(dev, ORG_B, (c) => c.query(text, values));
    await dev.end();
    expect(a.rows.map((r) => r.full_name)).toEqual(["Ana of A"]);
    expect(b.rows.map((r) => r.full_name)).toEqual(["Bo of B"]);
  });

  it("with no org in scope the view returns nothing — the wall fails closed", async () => {
    const dev = new Pool({ connectionString: p.urls.dev });
    const r = await dev.query(`select full_name from data_synth.v_people`);
    await dev.end();
    expect(r.rowCount).toBe(0);
  });

  it("a grant belongs to one org: org C sees no grant at all", async () => {
    await admin.query(`insert into app.organizations (id, name) values ('org-c','C')`);
    const r = await broker.query(makeCtx({ userId: "shared", orgId: "org-c" }), {
      collection: "people",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_grant");
  });

  it("RLS is enabled with an org_isolation policy on every data table", async () => {
    const r = await admin.query(
      `select schemaname, tablename from pg_policies where policyname='org_isolation' order by schemaname`,
    );
    // `_acl` is in the list for the same reason `people` is: it is a data table holding per-org
    // rows, and the read roles never touch it directly — but the write roles do, and RLS is their
    // wall. The view's own join carries `acl.org_id = base.org_id` explicitly; neither is
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

  it("audit rows carry the org the call was made in", async () => {
    const r = await broker.query(makeCtx({ userId: "shared", orgId: ORG_B }), {
      collection: "people",
    });
    const a = await admin.query(`select org_id from app.audit_events where id=$1`, [r.auditId]);
    expect(a.rows[0].org_id).toBe(ORG_B);
  });
});
