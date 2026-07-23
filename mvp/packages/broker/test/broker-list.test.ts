import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "t", server: { port: 1 }, synthetic: { documents_per_collection: {} },
  collections: {
    people: { description: "Employee directory", fields: { id: { type: "uuid", posture: "allow", pk: true } } },
    salaries: { description: "Comp", fields: { id: { type: "uuid", posture: "allow", pk: true } } },
  },
};
let p: Provisioned, admin: Pool, pools: Pools;
beforeAll(async () => {
  p = await provision("brokerl"); admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin); pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
});
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

it("lists names + descriptions only, even with zero grants", async () => {
  const broker = makeBroker(pools, cfg);
  const r = await broker.listCollections({ userId: "nobody", env: "dev" });
  expect(r).toEqual([
    { name: "people", description: "Employee directory" },
    { name: "salaries", description: "Comp" },
  ]);
});
