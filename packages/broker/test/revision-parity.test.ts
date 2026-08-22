import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker, type Pools } from "../src/index";
import { importCollection } from "../src/import/run";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { assertApplied } from "./helpers/results";

// A revision is written by two paths that know nothing about each other: broker.mutate, for a
// client holding a write grant, and importCollection, for an admin loading a file. Both now call
// db/revisions.ts, and this file is the assertion that they still produce the same thing.
//
// The contract under test is not "the two are implemented alike" — that is what the shared module
// is for. It is that the OBSERVABLE revision is identical: same op, same seq, same _current, same
// carried-forward columns, same visibility through the view. A future change that gives one path
// its own insert would compile, pass its own suite, and fail here.
//
// Three columns are excluded from the comparison and only those three: `_rev` (a fresh uuid),
// `_rev_at` (a clock) and `_rev_by` (genuinely different actors — a user versus an admin).
const VOLATILE = new Set(["_rev", "_rev_at", "_rev_by"]);

const cfg = ConfigSchema.parse({
  project: "parity",
  server: { port: 1 },
  collections: {
    notes: {
      description: "d",
      writable: true,
      fields: {
        id: { type: "uuid", posture: { read: "allow", write: "allow" }, pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
        body: { type: "text", posture: { read: "allow", write: "allow" }, nullable: true },
        note: { type: "text", posture: { read: "allow", write: "allow" }, nullable: true },
      },
    },
  },
});

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;

const ID = (n: string) => `00000000-0000-4000-8000-00000000000${n}`;

beforeAll(async () => {
  p = await provision("revparity");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({
    app: p.urls.admin,
    dev: p.urls.dev,
    live: p.urls.live,
    imp: p.urls.imp,
    liveWrite: p.urls.liveWrite,
  });
  broker = makeBroker(pools, cfg);
  // A live write grant for the mutate side. Import needs no grant — it is admin-only by role.
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status, verbs)
     values ('ana','notes',$1,'live','approved',$2)`,
    [
      ["id", "title", "body", "note"],
      ["read", "create", "update", "delete"],
    ],
  );
}, 60_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

// The stored revisions for one document, minus the columns that cannot match by construction.
async function history(id: string): Promise<Record<string, unknown>[]> {
  const r = await admin.query(`select * from data_live.notes where id=$1 order by _rev_seq`, [id]);
  return r.rows.map((row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).filter(([k]) => !VOLATILE.has(k))),
  );
}

const ctx = () => makeCtx({ userId: "ana", env: "live" });

describe("mutate and import produce the same revisions", () => {
  it("agree on create", async () => {
    const viaMutate = await broker.mutate(ctx(), {
      collection: "notes",
      op: "create",
      values: { id: ID("1"), title: "T", body: "B" },
    });
    assertApplied(viaMutate);

    const viaImport = await importCollection(
      pools,
      cfg,
      "ana",
      "notes",
      { format: "csv", text: `id,title,body\n${ID("2")},T,B` },
      { mode: "append" },
    );
    expect(viaImport.ok).toBe(true);

    const [m] = await history(ID("1"));
    const [i] = await history(ID("2"));
    // Same shape everywhere except the id itself.
    expect({ ...i, id: ID("1") }).toEqual(m);
    expect(m).toMatchObject({
      _rev_seq: "1",
      _rev_op: "create",
      _rev_status: "approved",
      _current: true,
    });
  });

  it("agree on update, including carrying untouched columns forward", async () => {
    for (const id of [ID("3"), ID("4")]) {
      const r = await broker.mutate(ctx(), {
        collection: "notes",
        op: "create",
        values: { id, title: "T", body: "B", note: "keep me" },
      });
      assertApplied(r);
    }

    const viaMutate = await broker.mutate(ctx(), {
      collection: "notes",
      op: "update",
      id: ID("3"),
      values: { title: "T2" },
    });
    assertApplied(viaMutate);

    const viaImport = await importCollection(
      pools,
      cfg,
      "ana",
      "notes",
      { format: "csv", text: `id,title\n${ID("4")},T2` },
      { mode: "upsert" },
    );
    expect(viaImport.ok).toBe(true);

    const m = await history(ID("3"));
    const i = await history(ID("4"));
    expect(i.map((r) => ({ ...r, id: ID("3") }))).toEqual(m);
    // Both left `note` alone, and both recorded only the field they actually set.
    expect(m[1]).toMatchObject({
      _rev_seq: "2",
      _rev_op: "update",
      _rev_base: "1",
      _current: true,
      title: "T2",
      note: "keep me",
      _rev_fields: ["title"],
    });
  });

  it("agree on delete, including that the document leaves the view and the history does not", async () => {
    for (const id of [ID("5"), ID("6")]) {
      const r = await broker.mutate(ctx(), {
        collection: "notes",
        op: "create",
        values: { id, title: "T", body: "B" },
      });
      assertApplied(r);
    }

    const viaMutate = await broker.mutate(ctx(), {
      collection: "notes",
      op: "delete",
      id: ID("5"),
    });
    assertApplied(viaMutate);

    const viaImport = await importCollection(
      pools,
      cfg,
      "ana",
      "notes",
      { format: "csv", text: `id\n${ID("6")}` },
      { mode: "delete" },
    );
    expect(viaImport.ok).toBe(true);

    const m = await history(ID("5"));
    const i = await history(ID("6"));
    expect(i.map((r) => ({ ...r, id: ID("5") }))).toEqual(m);
    expect(m[1]).toMatchObject({ _rev_op: "delete", _rev_fields: [], _current: true, title: "T" });

    // And neither is readable any more, by the same view predicate.
    await admin.query(`select set_config('warehousd.workspace_id','default',false)`);
    const visible = await admin.query(`select id from data_live.v_notes where id = any($1)`, [
      [ID("5"), ID("6")],
    ]);
    expect(visible.rowCount).toBe(0);
  });

  it("agree that a document deleted by one path can be recreated by neither", async () => {
    // A tombstone still holds the pk with _current, so the partial unique index makes a bare
    // re-create a conflict on both paths rather than a second live document.
    const created = await broker.mutate(ctx(), {
      collection: "notes",
      op: "create",
      values: { id: ID("7"), title: "T" },
    });
    assertApplied(created);
    const deleted = await broker.mutate(ctx(), { collection: "notes", op: "delete", id: ID("7") });
    assertApplied(deleted);

    const viaMutate = await broker.mutate(ctx(), {
      collection: "notes",
      op: "create",
      values: { id: ID("7"), title: "again" },
    });
    expect(viaMutate).toMatchObject({ ok: false, reason: "conflict" });

    const viaImport = await importCollection(
      pools,
      cfg,
      "ana",
      "notes",
      { format: "csv", text: `id,title\n${ID("7")},again` },
      { mode: "append" },
    );
    expect(viaImport).toMatchObject({ ok: false, reason: "constraint_violation" });
  });
});
