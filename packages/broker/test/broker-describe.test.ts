import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "t", server: { port: 1 }, synthetic: { documents_per_collection: {} },
  collections: { people: { description: "dir", fields: {
    id: { type: "uuid", posture: "allow", pk: true },
    email: { type: "text", posture: "allow" },
    home_address: { type: "text", posture: "deny" },
  }}},
};
let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
beforeAll(async () => {
  p = await provision("brokerd"); admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin); await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

it("no grant → refusal", async () => {
  const r = await broker.describeCollection({ userId: "x", orgId: "default", env: "dev" }, "people");
  expect("ok" in r && r.ok === false).toBe(true);
});
it("grant → only granted fields visible", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status)
    values ('x','people', array['id','email'],'dev','approved')`);
  const r = await broker.describeCollection({ userId: "x", orgId: "default", env: "dev" }, "people");
  expect("fields" in r).toBe(true);
  if ("fields" in r) expect(r.fields.map((f) => f.name).sort()).toEqual(["email", "id"]);
});
