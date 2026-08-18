import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import {
  createAppSchema,
  applyConfig,
  createPools,
  makeBroker,
  SEED_REV_COLUMNS,
  SEED_REV_VALUES,
} from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import { encodeCursor } from "../src/sql/cursor";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import type { Pools } from "../src/db/pools";

// Keyset pagination (Phase 2, P1-2): `after`/`nextCursor` on `query()`. One collection, one
// database, every scenario told apart by `scenario` so each test's rows never leak into another's
// walk — a single provision() is far cheaper than one per test and the isolation is just as real.

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  collections: {
    items: {
      description: "Items",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        seq: { type: "int", posture: "allow" },
        scenario: { type: "text", posture: "allow" },
        category: { type: "text", posture: "allow" },
        note: {
          type: "text",
          posture: { read: "mask", write: "deny" },
          mask: { transform: "redact" },
        },
        maybe: { type: "text", posture: "allow", nullable: true },
      },
    },
  },
});

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;

const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`.slice(0, 36);

async function seed(
  rows: { n: number; seq: number; scenario: string; category?: string | undefined }[],
) {
  if (!rows.length) return;
  const cols = ["id", "seq", "scenario", "category", "note", "maybe"];
  const values: unknown[] = [];
  const tuples = rows.map((r) => {
    const base = values.length;
    values.push(ID(r.n), r.seq, r.scenario, r.category ?? "keep", "n", null);
    return `(${SEED_REV_VALUES}, ${cols.map((_, i) => `$${base + i + 1}`).join(", ")})`;
  });
  await admin.query(
    `insert into data_synth.items (${SEED_REV_COLUMNS}, ${cols.join(", ")}) values ${tuples.join(", ")}`,
    values,
  );
}

async function grantOn(
  userId: string,
  fields: string[],
  opts: { documentFilters?: { field: string; op: string; value: unknown }[] } = {},
) {
  const id = await requestGrant(admin, {
    userId,
    collection: "items",
    env: "dev",
    workspaceId: "default",
    purposeLabel: "test",
    allowedFields: fields,
  });
  const r = await approveGrant(admin, cfg, id, "admin", {
    verbs: ["read"],
    ...(opts.documentFilters ? { documentFilters: opts.documentFilters as never } : {}),
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

beforeAll(async () => {
  p = await provision("keyset");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);

  // scenario "walk": 250 documents, seq 0..249 — test 1.
  await seed(Array.from({ length: 250 }, (_, i) => ({ n: i, seq: i, scenario: "walk" })));
  await grantOn("walker", ["id", "seq", "scenario", "category"]);

  // scenario "concurrent": 100 documents, seq spaced by 10 (0,10,...,990) so a later insert can
  // land strictly between two existing values — test 2.
  await seed(
    Array.from({ length: 100 }, (_, i) => ({ n: 1000 + i, seq: i * 10, scenario: "concurrent" })),
  );
  await grantOn("walker2", ["id", "seq", "scenario", "category"]);

  // scenario "desc": 40 documents, seq 0..39 — test 3.
  await seed(Array.from({ length: 40 }, (_, i) => ({ n: 2000 + i, seq: i, scenario: "desc" })));
  await grantOn("descwalker", ["id", "seq", "scenario", "category"]);

  // scenario "ties": 20 documents, only 3 distinct `category` values — tie-break test 4.
  await seed(
    Array.from({ length: 20 }, (_, i) => ({
      n: 3000 + i,
      seq: i,
      scenario: "ties",
      category: ["a", "b", "c"][i % 3],
    })),
  );
  await grantOn("tiewalker", ["id", "seq", "scenario", "category"]);

  // scenario "docfilter": 60 documents, half category "keep" half "drop" — test 7 and the forged
  // cursor test for criterion 2.4. The grant excludes "drop" via a document filter.
  await seed(
    Array.from({ length: 60 }, (_, i) => ({
      n: 4000 + i,
      seq: i,
      scenario: "docfilter",
      category: i % 2 === 0 ? "keep" : "drop",
    })),
  );
  await grantOn("filtered", ["id", "seq", "scenario", "category"], {
    documentFilters: [{ field: "category", op: "eq", value: "keep" }],
  });

  // scenario "small": a handful of documents for the single-collection refusal tests (5, 6, 8, 9,
  // 10, 11) that do not need a full walk.
  await seed(Array.from({ length: 5 }, (_, i) => ({ n: 5000 + i, seq: i, scenario: "small" })));
  await grantOn("smallwalker", ["id", "seq", "scenario", "category", "note"]);
  // A grant that carries every field except the pk itself — test 11.
  await grantOn("nopk", ["seq", "scenario", "category"]);
}, 60_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

// Walk `userId` through `scenario` with `after`/`nextCursor`, page by page, until a short page
// ends it. Returns every page's documents in order, plus the pages themselves for tests that need
// per-page shape.
async function walk(
  userId: string,
  scenario: string,
  opts: {
    limit: number;
    orderBy?: { field: string; dir: "asc" | "desc" };
    fields?: string[];
    maxPages?: number;
  },
) {
  const pages: Record<string, unknown>[][] = [];
  let after: string | undefined;
  let guard = 0;
  const maxPages = opts.maxPages ?? 100;
  for (;;) {
    guard++;
    if (guard > maxPages) throw new Error("walk did not terminate");
    const r = await broker.query(makeCtx({ userId }), {
      collection: "items",
      fields: opts.fields ?? ["id", "seq"],
      filters: [{ field: "scenario", op: "eq", value: scenario }],
      orderBy: opts.orderBy ?? { field: "seq", dir: "asc" },
      limit: opts.limit,
      ...(after !== undefined ? { after } : {}),
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    pages.push(r.documents);
    if (r.nextCursor === undefined) break;
    after = r.nextCursor;
  }
  return pages;
}

it("test 1: walks 250 documents in pages of 30, every one exactly once, in order", async () => {
  const pages = await walk("walker", "walk", { limit: 30 });
  const seqs = pages.flat().map((d) => d.seq);
  expect(seqs).toEqual(Array.from({ length: 250 }, (_, i) => i));
  // Full pages of 30 until the last, which is short (250 = 8*30 + 10).
  expect(pages.slice(0, -1).every((p) => p.length === 30)).toBe(true);
  const lastPage = pages[pages.length - 1];
  expect(lastPage?.length).toBe(10);
});

describe("test 2: correctness under concurrent insert", () => {
  it("keyset sees every original document exactly once; the newly inserted row never appears", async () => {
    // Walk two pages (60 of 100 documents, cursor now past seq=590).
    const page1 = await broker.query(makeCtx({ userId: "walker2" }), {
      collection: "items",
      fields: ["id", "seq"],
      filters: [{ field: "scenario", op: "eq", value: "concurrent" }],
      orderBy: { field: "seq", dir: "asc" },
      limit: 30,
    });
    expect(page1.ok).toBe(true);
    if (!page1.ok) throw new Error("unreachable");
    const page2 = await broker.query(makeCtx({ userId: "walker2" }), {
      collection: "items",
      fields: ["id", "seq"],
      filters: [{ field: "scenario", op: "eq", value: "concurrent" }],
      orderBy: { field: "seq", dir: "asc" },
      limit: 30,
      after: page1.nextCursor,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) throw new Error("unreachable");
    expect(page2.nextCursor).toBeTruthy();

    // A document that sorts BEFORE the cursor (seq 590) — inside the range already walked.
    await seed([{ n: 1500, seq: 455, scenario: "concurrent" }]);

    // Continue the walk from page2's cursor.
    const rest: Record<string, unknown>[][] = [page1.documents, page2.documents];
    let after = page2.nextCursor;
    for (;;) {
      const r = await broker.query(makeCtx({ userId: "walker2" }), {
        collection: "items",
        fields: ["id", "seq"],
        filters: [{ field: "scenario", op: "eq", value: "concurrent" }],
        orderBy: { field: "seq", dir: "asc" },
        limit: 30,
        after,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      rest.push(r.documents);
      if (r.nextCursor === undefined) break;
      after = r.nextCursor;
    }

    const ids = rest.flat().map((d) => d.id);
    // Every one of the 100 ORIGINAL documents exactly once, no duplicates.
    expect(ids.length).toBe(100);
    expect(new Set(ids).size).toBe(100);
    // The document inserted at seq=455 — behind the cursor by the time it landed — never appears.
    expect(ids).not.toContain(ID(1500));

    await admin.query(`delete from data_synth.items where id = $1`, [ID(1500)]);
  });

  it("the equivalent offset walk does not give the same guarantee under the identical insert", async () => {
    // Same starting data (fresh scenario, offset instead of after). Two pages fetched first.
    const fetch = (offset: number) =>
      broker.query(makeCtx({ userId: "walker2" }), {
        collection: "items",
        fields: ["id", "seq"],
        filters: [{ field: "scenario", op: "eq", value: "concurrent" }],
        orderBy: { field: "seq", dir: "asc" },
        limit: 30,
        offset,
      });
    const p1 = await fetch(0);
    const p2 = await fetch(30);
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) throw new Error("unreachable");

    await seed([{ n: 1501, seq: 455, scenario: "concurrent" }]);

    const p3 = await fetch(60);
    const p4 = await fetch(90);
    expect(p3.ok && p4.ok).toBe(true);
    if (!p3.ok || !p4.ok) throw new Error("unreachable");

    const ids = [...p1.documents, ...p2.documents, ...p3.documents, ...p4.documents].map(
      (d) => d.id,
    );
    // Offset re-counts from the top of the CURRENT result set on every call. Inserting a row
    // behind the already-fetched boundary shifts every later position by one, so the same
    // document resurfaces across two offset windows — exactly the failure keyset does not have.
    expect(ids.length).toBeGreaterThan(new Set(ids).size);

    await admin.query(`delete from data_synth.items where id = $1`, [ID(1501)]);
  });
});

it("test 3: dir desc walks in reverse correctly", async () => {
  const pages = await walk("descwalker", "desc", {
    limit: 15,
    orderBy: { field: "seq", dir: "desc" },
  });
  const seqs = pages.flat().map((d) => d.seq);
  expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => 39 - i));
});

it("test 4: ties on the sort field are broken by pk deterministically across two identical walks", async () => {
  const walk1 = await walk("tiewalker", "ties", {
    limit: 4,
    orderBy: { field: "category", dir: "asc" },
    fields: ["id", "seq", "category"],
  });
  const walk2 = await walk("tiewalker", "ties", {
    limit: 4,
    orderBy: { field: "category", dir: "asc" },
    fields: ["id", "seq", "category"],
  });
  expect(walk1.flat().map((d) => d.id)).toEqual(walk2.flat().map((d) => d.id));
});

it("test 5: a cursor minted under one orderBy refuses under another", async () => {
  const first = await broker.query(makeCtx({ userId: "smallwalker" }), {
    collection: "items",
    fields: ["id", "seq"],
    filters: [{ field: "scenario", op: "eq", value: "small" }],
    orderBy: { field: "seq", dir: "asc" },
    limit: 2,
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("unreachable");
  expect(first.nextCursor).toBeTruthy();

  const r = await broker.query(makeCtx({ userId: "smallwalker" }), {
    collection: "items",
    fields: ["id", "seq"],
    filters: [{ field: "scenario", op: "eq", value: "small" }],
    orderBy: { field: "category", dir: "asc" },
    limit: 2,
    after: first.nextCursor,
  });
  expect(r).toMatchObject({ ok: false, reason: "invalid_intent" });
});

it("test 6: a garbage `after` string refuses invalid_intent, audited, no documents returned", async () => {
  const r = await broker.query(makeCtx({ userId: "smallwalker" }), {
    collection: "items",
    fields: ["id", "seq"],
    filters: [{ field: "scenario", op: "eq", value: "small" }],
    orderBy: { field: "seq", dir: "asc" },
    limit: 2,
    after: "%%% not a cursor %%%",
  });
  expect(r).toMatchObject({ ok: false, reason: "invalid_intent" });
  if (r.ok) throw new Error("unreachable");
  expect(r.auditId).toBeTruthy();
  const row = await admin.query(`select outcome, reason from app.audit_events where id = $1`, [
    r.auditId,
  ]);
  expect(row.rows[0]).toEqual({ outcome: "refused", reason: "invalid_intent" });
});

it("test 7: the grant's document filter still applies on every keyset page", async () => {
  const pages = await walk("filtered", "docfilter", { limit: 10 });
  const flat = pages.flat();
  // 30 "keep" documents out of 60; none of the "drop" documents ever surface, and the pages are
  // still filled to the limit (proving the filter runs inside the WHERE the LIMIT applies to,
  // rather than after it — a filtered-out document never shortens a page).
  expect(flat.length).toBe(30);
  expect(pages.slice(0, -1).every((p) => p.length === 10)).toBe(true);
});

it("test 8: a masked sort field refuses field_denied", async () => {
  const r = await broker.query(makeCtx({ userId: "smallwalker" }), {
    collection: "items",
    fields: ["id"],
    filters: [{ field: "scenario", op: "eq", value: "small" }],
    orderBy: { field: "note", dir: "asc" },
    limit: 2,
  });
  expect(r).toMatchObject({ ok: false, reason: "field_denied" });
});

it("test 9: `after` and `offset` together refuse invalid_intent", async () => {
  const r = await broker.query(makeCtx({ userId: "smallwalker" }), {
    collection: "items",
    fields: ["id"],
    filters: [{ field: "scenario", op: "eq", value: "small" }],
    limit: 2,
    offset: 1,
    after: "anything",
  });
  expect(r).toMatchObject({ ok: false, reason: "invalid_intent" });
});

it("test 10: a nullable sort field refuses invalid_intent", async () => {
  const r = await broker.query(makeCtx({ userId: "smallwalker" }), {
    collection: "items",
    fields: ["id"],
    filters: [{ field: "scenario", op: "eq", value: "small" }],
    orderBy: { field: "maybe", dir: "asc" },
    limit: 2,
  });
  expect(r).toMatchObject({ ok: false, reason: "invalid_intent" });
});

it("test 11: a pk outside allowedFields refuses field_denied", async () => {
  const r = await broker.query(makeCtx({ userId: "nopk" }), {
    collection: "items",
    fields: ["seq"],
    filters: [{ field: "scenario", op: "eq", value: "small" }],
    orderBy: { field: "seq", dir: "asc" },
    limit: 2,
  });
  expect(r).toMatchObject({ ok: false, reason: "field_denied" });
});

// Criterion 2.4: a forged cursor is no more powerful than a `gt` filter the caller could already
// write — the grant's document filter is ANDed into the same WHERE regardless of where the cursor
// came from, so pointing one past an excluded document does not reveal it.
it("criterion 2.4: a hand-built cursor pointing past a `drop` document never reveals it", async () => {
  // Position the forged cursor at seq=-1 — before every real document — so a full walk from here
  // would cross every "drop" row's position if the filter were not applied.
  const forged = encodeCursor({
    v: 1,
    f: "seq",
    d: "asc",
    k: [-1, "00000000-0000-4000-8000-000000000000"],
  });
  const r = await broker.query(makeCtx({ userId: "filtered" }), {
    collection: "items",
    fields: ["id", "seq", "category"],
    filters: [{ field: "scenario", op: "eq", value: "docfilter" }],
    orderBy: { field: "seq", dir: "asc" },
    limit: 60,
    after: forged,
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  expect(r.documents.every((d) => d.category === "keep")).toBe(true);
  expect(r.documents.length).toBe(30);
});
