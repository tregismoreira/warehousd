import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, DEFAULT_WORKSPACE_ID } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// §5.0: `workspaces.enabled` gates the platform provisioning surface only. Isolation itself —
// RLS, the view predicates, audit's workspace_id — is unconditional in both states. This suite
// builds the exact same fixtures under `enabled: false` and `enabled: true` and asserts the
// isolation behaviour is identical, which is acceptance 5d ("flipping the flag changes no
// assertion in 5c") made concrete rather than merely claimed.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

const WORKSPACE_A = DEFAULT_WORKSPACE_ID;
const WORKSPACE_B = "workspace-toggle-b";

function cfgWith(enabled: boolean): WarehousdConfig {
  return ConfigSchema.parse({
    project: "t",
    server: { port: 1 },
    synthetic: { documents_per_collection: {} },
    taxonomies: {},
    demo: false,
    workspaces: { enabled },
    collections: {
      people: {
        description: "dir",
        type: "dataset",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          full_name: { type: "text", posture: "allow" },
        },
      },
      notes: {
        description: "notes",
        writable: true,
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          body: { type: "text", posture: { read: "allow", write: "allow" } },
        },
      },
    },
  });
}

describe.each([
  ["workspaces.enabled: false", false],
  ["workspaces.enabled: true", true],
])("%s", (_label, enabled) => {
  const cfg = cfgWith(enabled);
  const suffix = enabled ? "on" : "off";

  let p: Provisioned;
  let admin: Pool;
  let pools: Pools;
  let broker: ReturnType<typeof makeBroker>;

  beforeAll(async () => {
    p = await provision(`wstoggle${suffix}`);
    admin = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(admin);
    await admin.query(`insert into app.workspaces (id, name) values ($1,'B')`, [WORKSPACE_B]);
    await applyConfig(admin, cfg);

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

  it("a cross-workspace read is still refused", async () => {
    const r = await broker.query(makeCtx({ userId: "shared", workspaceId: WORKSPACE_A }), {
      collection: "people",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.map((d) => d.full_name)).toEqual(["Ana of A"]);
  });

  it("an unscoped write is still rejected by RLS", async () => {
    const write = new Pool({ connectionString: p.urls.devWrite });
    try {
      await expect(
        write.query(
          `insert into data_synth.notes (${R}, id, body) values (${RV}, gen_random_uuid(), 'x')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await write.end();
    }
  });

  it("audit rows still carry workspace_id", async () => {
    const r = await broker.query(makeCtx({ userId: "shared", workspaceId: WORKSPACE_B }), {
      collection: "people",
    });
    expect(r.ok).toBe(true);

    const row = await admin.query(
      `select workspace_id from app.audit_events where user_id='shared' order by at desc limit 1`,
    );
    expect(row.rows[0].workspace_id).toBe(WORKSPACE_B);
  });
});
