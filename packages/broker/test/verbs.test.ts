import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { validateVerbs, requestGrant, approveGrant } from "../src/grants/manage";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    people: {
      description: "People",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: { read: "allow", write: "allow" } },
        name: { type: "text", posture: "allow" },
      },
    },
    policies: {
      type: "file",
      description: "Policies",
      source: "./x",
      writable: true,
      fields: {
        title: { posture: { read: "allow", write: "allow" } },
        content: { posture: "allow" },
        owner: { posture: "allow" },
        updated_at: { posture: "allow" },
        path: { posture: "deny" },
      },
    },
  },
});

let p: Provisioned;
let db: Pool;
let pools: Pools;
let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("verbs");
  db = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(db);
  await applyConfig(db, cfg);

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});

afterAll(async () => {
  await db.end();
  await pools.end();
  await p.end();
});

it("existing grants default to ['read']", async () => {
  // Insert a grant without specifying verbs (simulates pre-Phase-2 data)
  const r = await db.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ($1, $2, $3, $4, $5) returning id, verbs`,
    ["u1", "people", ["id", "email"], "dev", "approved"],
  );
  expect(r.rows[0].verbs).toEqual(["read"]);
});

it("a grant lacking 'read' refuses query with no_grant (not a new code)", async () => {
  // Insert a grant with write verbs but no read
  await db.query(
    `insert into app.grants (id, user_id, collection, allowed_fields, env, status, verbs)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
    ["u_no_read", "people", ["id", "email"], "dev", "approved", ["create"]],
  );

  const r = await broker.query(makeCtx({ userId: "u_no_read" }), {
    collection: "people",
    fields: ["id"],
  });
  expect(r).toMatchObject({ ok: false, reason: "no_grant" });
});

it("'approve' without 'read' is rejected at approval time", () => {
  const result = validateVerbs(["approve"], cfg, "people", ["email"]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("read");
});

it("a write verb on a file collection's update is rejected", () => {
  // File collections only support 'create', not 'update'
  const result = validateVerbs(["read", "update"], cfg, "policies", ["title"]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("update");
});

it("a write verb with no writable field in allowed_fields is rejected", () => {
  // 'people' has email writable, but denied in this grant
  const result = validateVerbs(["read", "create"], cfg, "people", ["id", "name"]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("writable");
});

it("'create' on a dataset collection is accepted if email (writable) is granted", () => {
  const result = validateVerbs(["read", "create"], cfg, "people", ["email"]);
  expect(result.ok).toBe(true);
});

it("'create' on a file collection is accepted if title is granted", () => {
  const result = validateVerbs(["read", "create"], cfg, "policies", ["title"]);
  expect(result.ok).toBe(true);
});

it("an append-only grant needs no read verb — create without read is valid", () => {
  // Read is required *by approve*, not in general. An ingestion agent that may write and may
  // never read back is a legitimate shape, and forcing read onto it would widen its access.
  expect(validateVerbs(["create"], cfg, "people", ["email"]).ok).toBe(true);
});

it("an unknown verb is refused rather than silently stored", () => {
  const r = validateVerbs(["read", "publish"], cfg, "people", ["email"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("publish");
});

it("an empty verb list is refused — a grant that can do nothing is a mistake", () => {
  expect(validateVerbs([], cfg, "people", ["email"]).ok).toBe(false);
});

it("approveGrant refuses invalid verbs instead of writing them", async () => {
  const id = await requestGrant(db, {
    userId: "u_bad_verbs",
    collection: "people",
    env: "dev",
    purposeLabel: "t",
    allowedFields: ["id", "name"],
  });
  const r = await approveGrant(db, cfg, id, "marcus", { verbs: ["read", "create"] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("invalid_verbs");
  const row = await db.query(`select status from app.grants where id=$1`, [id]);
  expect(row.rows[0].status).toBe("pending");
});

it("approveGrant stores the verbs and mode it was given", async () => {
  const id = await requestGrant(db, {
    userId: "u_good_verbs",
    collection: "people",
    env: "dev",
    purposeLabel: "t",
    allowedFields: ["id", "email"],
  });
  expect(
    (
      await approveGrant(db, cfg, id, "marcus", {
        verbs: ["read", "create"],
        mode: "proposal_only",
      })
    ).ok,
  ).toBe(true);
  const row = await db.query(`select verbs, mode from app.grants where id=$1`, [id]);
  expect(row.rows[0].verbs).toEqual(["read", "create"]);
  expect(row.rows[0].mode).toBe("proposal_only"); // Phase 5 is what makes it behave
});

it("read-only grant allows query", async () => {
  // Setup grant with read only
  await db.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status, verbs)
     values ($1, $2, $3, $4, $5, $6)`,
    ["u_read_only", "people", ["id", "email"], "dev", "approved", ["read"]],
  );

  const r = await broker.query(makeCtx({ userId: "u_read_only" }), {
    collection: "people",
    fields: ["id"],
  });
  expect(r.ok).toBe(true);
});
