import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import type { WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { ConfigSchema } from "../src/config/schema";
import { requestGrant, approveGrant } from "../src/grants/manage";

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  synthetic: { documents_per_collection: {} },
  collections: {
    people: {
      description: "Employee directory",
      fields: { id: { type: "uuid", posture: "allow", pk: true } },
    },
    salaries: { description: "Comp", fields: { id: { type: "uuid", posture: "allow", pk: true } } },
  },
});
let p: Provisioned, admin: Pool, pools: Pools;
beforeAll(async () => {
  p = await provision("brokerl");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
});
afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

// §P2. The listing now carries the caller's OWN access, which is what stops a model burning one
// describe call per collection to find the three it can read. It is not a disclosure: a caller
// learns only about grants it already holds — with none, every row says "none" and the payload is
// otherwise what it always was.
it("lists names + descriptions, and says the caller holds nothing", async () => {
  const broker = makeBroker(pools, cfg);
  const r = await broker.listCollections(makeCtx({ userId: "nobody" }));
  expect(r).toEqual([
    { name: "people", description: "Employee directory", access: "none" },
    { name: "salaries", description: "Comp", access: "none" },
  ]);
});

it("writes an audit row with collection='*' and outcome='allowed'", async () => {
  const broker = makeBroker(pools, cfg);
  await broker.listCollections(makeCtx({ userId: "alice", env: "live" }));
  const audit = await admin.query(
    `select user_id, env, collection, outcome, reason from app.audit_events
     where user_id='alice' and env='live' and collection='*' order by at desc limit 1`,
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toEqual({
    user_id: "alice",
    env: "live",
    collection: "*",
    outcome: "allowed",
    reason: null,
  });
});

// The other half of the annotation: a caller that DOES hold a grant sees so, and sees how much of
// the collection it carries. Without the count, "granted" is the same word for a grant carrying
// one field and one carrying twenty.
it("annotates the collections the caller holds, with the granted field count", async () => {
  const broker = makeBroker(pools, cfg);
  const id = await requestGrant(admin, {
    userId: "held",
    collection: "people",
    env: "dev",
    workspaceId: "default",
    purposeLabel: "t",
    allowedFields: ["id"],
  });
  const approved = await approveGrant(admin, cfg, id, "boss", { allowedFields: ["id"] });
  expect(approved.ok).toBe(true);

  const r = await broker.listCollections(makeCtx({ userId: "held" }));
  expect(r).toEqual([
    { name: "people", description: "Employee directory", access: "granted", grantedFields: 1 },
    { name: "salaries", description: "Comp", access: "none" },
  ]);
});

// One round trip for the whole page, not one per collection. `loadActiveGrants` exists for exactly
// this shape, and the listing is the first thing a caller opens.
it("resolves every collection's access in a single grant lookup", async () => {
  const broker = makeBroker(pools, cfg);
  const spy = vi.spyOn(pools.app, "query");
  try {
    await broker.listCollections(makeCtx({ userId: "held" }));
    const grantLookups = spy.mock.calls.filter(([q]) =>
      (typeof q === "string" ? q : ((q as { text?: string }).text ?? "")).includes(
        "from app.grants",
      ),
    );
    // Two collections in this config; the count must not track that number.
    expect(grantLookups).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});
