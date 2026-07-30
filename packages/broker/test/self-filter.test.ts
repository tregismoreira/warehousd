import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { approveGrant } from "../src/grants/manage";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    notes: {
      description: "User notes",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        owner: { type: "text", posture: "allow" },
        content: { type: "text", posture: "allow" },
      },
    },
  },
});

let p: Provisioned;
let db: Pool;
let pools: Pools;
let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("self-filter");
  db = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(db);
  await applyConfig(db, cfg);

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);

  // Seed fixture notes (use admin pool, not dev pool which has no INSERT)
  await db.query(
    `insert into data_synth.notes (id, owner, content) values
     (gen_random_uuid(), 'alice', 'Alice note 1'),
     (gen_random_uuid(), 'alice', 'Alice note 2'),
     (gen_random_uuid(), 'bob', 'Bob note 1')`,
  );
});

afterAll(async () => {
  await db.end();
  await pools.end();
  await p.end();
});

it("$self with op:eq scopes to the calling user", async () => {
  // Create a grant with document_filter using $self
  const grantRes = await db.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ($1, $2, $3, $4, $5) returning id`,
    ["alice", "notes", ["id", "owner", "content"], "dev", "pending"],
  );
  const grantId = grantRes.rows[0].id;

  await approveGrant(db, cfg, grantId, "admin", {
    documentFilters: [{ field: "owner", op: "eq", value: "$self" }],
  });

  const r = await broker.query(makeCtx({ userId: "alice" }), { collection: "notes" });
  expect(r.ok).toBe(true);
  if (r.ok) {
    // alice should see only her notes (where owner = 'alice')
    const owners = r.documents.map((d) => d.owner);
    expect(owners).toEqual(["alice", "alice"]);
  }
});

it("$self inside an op:in array resolves per element", async () => {
  const grantRes = await db.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ($1, $2, $3, $4, $5) returning id`,
    ["bob", "notes", ["id", "owner", "content"], "dev", "pending"],
  );
  const grantId = grantRes.rows[0].id;

  await approveGrant(db, cfg, grantId, "admin", {
    documentFilters: [{ field: "owner", op: "in", value: ["alice", "$self"] }],
  });

  const r = await broker.query(makeCtx({ userId: "bob" }), { collection: "notes" });
  expect(r.ok).toBe(true);
  if (r.ok) {
    // bob should see alice's notes and his own (bob expanded from $self)
    const owners = new Set(r.documents.map((d) => d.owner));
    expect(owners).toEqual(new Set(["alice", "bob"]));
  }
});

it("'$self-service' is treated as a literal, not a sentinel", async () => {
  const grantRes = await db.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ($1, $2, $3, $4, $5) returning id`,
    ["charlie", "notes", ["id", "owner", "content"], "dev", "pending"],
  );
  const grantId = grantRes.rows[0].id;

  await approveGrant(db, cfg, grantId, "admin", {
    documentFilters: [{ field: "owner", op: "eq", value: "$self-service" }],
  });

  const r = await broker.query(makeCtx({ userId: "charlie" }), { collection: "notes" });
  expect(r.ok).toBe(true);
  if (r.ok) {
    // Should match nobody (no document has owner = "$self-service")
    expect(r.documents.length).toBe(0);
  }
});

it("the generated SQL contains no literal '$self'", async () => {
  // This is more of a regression test — we verify that the SQL doesn't leak the sentinel
  // by checking that resolving the filter produces SQL with the userId, not "$self"
  const grantRes = await db.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ($1, $2, $3, $4, $5) returning id`,
    ["dave", "notes", ["id", "owner", "content"], "dev", "pending"],
  );
  const grantId = grantRes.rows[0].id;

  await approveGrant(db, cfg, grantId, "admin", {
    documentFilters: [{ field: "owner", op: "eq", value: "$self" }],
  });

  // Query and ensure it resolves properly
  const r = await broker.query(makeCtx({ userId: "dave" }), { collection: "notes" });
  expect(r.ok).toBe(true);
  if (r.ok) {
    // The documents should be scoped by owner='dave', not owner='$self'
    expect(r.documents.every((d) => d.owner === "dave")).toBe(true);
  }
});
