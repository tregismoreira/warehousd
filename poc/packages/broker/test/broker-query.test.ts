import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { generateSynthetic } from "../src/synthetic/generate";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "t", server: { port: 1 }, synthetic: { rows_per_collection: { people: 12 } },
  collections: { people: { description: "dir", fields: {
    id: { type: "uuid", posture: "allow", pk: true },
    full_name: { type: "text", posture: "allow" },
    email: { type: "text", posture: "allow" },
    home_address: { type: "text", posture: "deny" },
  }}},
};

let p: Provisioned; let admin: Pool; let pools: Pools; let broker: ReturnType<typeof makeBroker>;
beforeAll(async () => {
  p = await provision("brokerq");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  await generateSynthetic(admin, cfg, 7);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

it("no grant → no_grant, still audited", async () => {
  const r = await broker.query({ userId: "u", env: "dev" }, { collection: "people" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("no_grant");
  const a = await admin.query(`select outcome, reason from app.audit_events where id=$1`, [r.auditId]);
  expect(a.rows[0]).toEqual({ outcome: "refused", reason: "no_grant" });
});

it("grant excluding email → requesting email is field_denied", async () => {
  await admin.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status)
     values ('u2','people', array['id','full_name'],'dev','approved')`);
  const r = await broker.query({ userId: "u2", env: "dev" },
    { collection: "people", fields: ["id", "email"] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("field_denied");
});

it("grant excluding email → default fields omit the email key entirely (absent, not null)", async () => {
  const r = await broker.query({ userId: "u2", env: "dev" }, { collection: "people", limit: 3 });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.fieldsReturned.sort()).toEqual(["full_name", "id"]);
    for (const row of r.rows) {
      expect("email" in row).toBe(false);
      expect("home_address" in row).toBe(false);
    }
  }
});

it("unknown collection / unknown field", async () => {
  const r1 = await broker.query({ userId: "u2", env: "dev" }, { collection: "nope" });
  if (!r1.ok) expect(r1.reason).toBe("unknown_collection");
  const r2 = await broker.query({ userId: "u2", env: "dev" },
    { collection: "people", fields: ["id", "ghost"] });
  if (!r2.ok) expect(r2.reason).toBe("unknown_field");
});
