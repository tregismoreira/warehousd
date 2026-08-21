import { it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { loadActiveGrant, loadActiveGrants } from "../src/grants/eval";
import { makeCtx } from "./helpers/ctx";
import type { BrokerContext } from "../src/types";

// loadActiveGrants exists only to save round trips, so the thing worth testing is that it changed
// nothing else. Every case below asserts the batch answer against the per-collection loader rather
// than against a literal: a divergence in the ceiling, the supersede tie-break or the $self
// binding is a grant evaluated differently depending on which verb asked, which is an enforcement
// bug, not a performance one.
let p: Provisioned;
let db: Pool;

const COLLECTIONS = ["people", "policies", "orders", "ungranted"];

beforeAll(async () => {
  p = await provision("grantbatch");
  db = testPool({ connectionString: p.urls.admin });
  await createAppSchema(db);

  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at,verbs,mode)
     values ('mia','people', array['id','email'],'dev','approved', now() + interval '1 day', array['read'], 'direct')`,
  );
  // Superseded: an older grant that has been revoked, and the newer approved one that replaced
  // it. Two approved rows cannot coexist — `grants_one_active` is unique on
  // (workspace_id, user_id, collection, env) where status='approved' — so this is what "superseded"
  // actually looks like in the table, and both loaders must ignore the dead row.
  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at,requested_at)
     values ('mia','orders', array['id'],'dev','revoked', null, now() - interval '2 days')`,
  );
  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at,requested_at)
     values ('mia','orders', array['id','total'],'dev','approved', null, now() - interval '1 hour')`,
  );
  // Expired, so neither loader may see it.
  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at)
     values ('mia','policies', array['title'],'dev','approved', now() - interval '1 hour')`,
  );
  // $self, both as a bare value and inside an `in` list.
  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter)
     values ('ana','people', array['id'],'dev','approved',
             '[{"field":"owner","op":"eq","value":"$self"},{"field":"reviewer","op":"in","value":["$self","marcus"]}]')`,
  );
});

afterAll(async () => {
  await db?.end();
  await p?.end();
});

// The map's contract: an entry exists exactly where the single loader returns non-null, and the
// entry equals what it returned.
async function expectParity(ctx: BrokerContext, collections: string[]) {
  const batch = await loadActiveGrants(db, ctx, collections);
  for (const c of collections) {
    const one = await loadActiveGrant(db, ctx, c);
    expect(batch.get(c) ?? null, `collection ${c}`).toEqual(one);
  }
  // Nothing extra: the map must not name a collection that was never asked about.
  for (const c of batch.keys()) expect(collections).toContain(c);
  return batch;
}

it("matches loadActiveGrant across granted, ungranted, expired and superseded collections", async () => {
  const batch = await expectParity(makeCtx({ userId: "mia" }), COLLECTIONS);

  // Guard the parity assertion itself: if both loaders were broken the same way, the loop above
  // would still pass. These pin what the right answer actually is.
  expect(batch.get("people")?.allowedFields).toEqual(["id", "email"]);
  expect(batch.get("orders")?.allowedFields).toEqual(["id", "total"]); // the revoked one is gone
  expect(batch.has("policies")).toBe(false); // expired
  expect(batch.has("ungranted")).toBe(false);
});

it("applies the collection ceiling the same way the single loader does", async () => {
  // Ceiling excludes the granted collection.
  const excluded = await expectParity(
    makeCtx({ userId: "mia", allowedCollections: ["policies"] }),
    COLLECTIONS,
  );
  expect(excluded.has("people")).toBe(false);

  // Ceiling includes it.
  const included = await expectParity(
    makeCtx({ userId: "mia", allowedCollections: ["people"] }),
    COLLECTIONS,
  );
  expect(included.has("people")).toBe(true);

  // No ceiling at all.
  const uncapped = await expectParity(
    makeCtx({ userId: "mia", allowedCollections: null }),
    COLLECTIONS,
  );
  expect(uncapped.has("people")).toBe(true);

  // An empty ceiling admits nothing, and must not be mistaken for "no ceiling".
  const empty = await loadActiveGrants(
    db,
    makeCtx({ userId: "mia", allowedCollections: [] }),
    COLLECTIONS,
  );
  expect(empty.size).toBe(0);
});

it("binds $self identically, including inside an in-list", async () => {
  const ctx = makeCtx({ userId: "ana" });
  const batch = await expectParity(ctx, ["people"]);

  expect(batch.get("people")?.documentFilter).toEqual([
    { field: "owner", op: "eq", value: "ana" },
    { field: "reviewer", op: "in", value: ["ana", "marcus"] },
  ]);
});

it("is env- and workspace-scoped like the single loader", async () => {
  await expectParity(makeCtx({ userId: "mia", env: "live" }), COLLECTIONS);
  await expectParity(makeCtx({ userId: "mia", workspaceId: "other" }), COLLECTIONS);
});

it("returns an empty map for an empty collection list without querying", async () => {
  const batch = await loadActiveGrants(db, makeCtx({ userId: "mia" }), []);
  expect(batch.size).toBe(0);
});

it("handles a multi-collection list in one call", async () => {
  const batch = await loadActiveGrants(db, makeCtx({ userId: "mia" }), ["people", "orders"]);
  expect([...batch.keys()].sort()).toEqual(["orders", "people"]);
});
