import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { provision, type Provisioned } from "./helpers/db";
import { ConfigSchema } from "../src/config/schema";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { indexCollection, syncDatasetTerms } from "../src/indexing";
import { makeBroker } from "../src/broker";
import { createPools, type Pools } from "../src/db/pools";

let p: Provisioned; let admin: Pool; let pools: Pools;
let broker: ReturnType<typeof makeBroker>;

const cfg = ConfigSchema.parse({
  project: "t", server: { port: 1 },
  taxonomies: { category: { label: "Category", terms: {
    hr: { label: "HR" }, finance: { label: "Finance" } } } },
  collections: {
    notes: { description: "notes", taxonomies: ["category"], fields: {
      id: { type: "uuid", posture: "allow", pk: true },
      body: { type: "text", posture: "allow" } } },
    briefs: { description: "briefs", type: "file", source: "./unused", taxonomies: ["category"], fields: {
      title: { posture: "allow" }, content: { posture: "allow" },
      path: { posture: "deny" }, category: { posture: "allow" } } },
  },
});

beforeAll(async () => {
  p = await provision("taxgrants");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  // structured rows: 2 hr, 1 finance
  await admin.query(`insert into data_synth.notes (id, body, category) values
    (gen_random_uuid(), 'hr note one', 'hr'),
    (gen_random_uuid(), 'hr note two', 'hr'),
    (gen_random_uuid(), 'finance note', 'finance')`);
  // documents: one per term
  const dir = mkdtempSync(join(tmpdir(), "taxdocs-"));
  writeFileSync(join(dir, "handbook.md"), "---\ncategory: hr\n---\n# Handbook\n\nVacation policy paragraph.");
  writeFileSync(join(dir, "budget.md"), "---\ncategory: finance\n---\n# Budget\n\nVacation budget paragraph.");
  await syncDatasetTerms(admin, cfg, "dev");
  await indexCollection(admin, cfg, "dev", "briefs", dir);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});

afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

async function grant(user: string, collection: string, fields: string[], documentFilter: object | null) {
  await admin.query(`delete from app.grants where user_id=$1 and collection=$2`, [user, collection]);
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status, document_filter)
     values ($1,$2,$3,'dev','approved',$4)`,
    [user, collection, fields, documentFilter ? JSON.stringify(documentFilter) : null]);
}

describe("term-scoped grants: structured", () => {
  it("document_filter on the term restricts documents; excluded documents silently absent", async () => {
    await grant("u1", "notes", ["id", "body", "category"],
      { field: "category", op: "in", value: ["hr"] });
    const r = await broker.query({ userId: "u1", env: "dev" }, { collection: "notes" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documents.length).toBe(2);
      for (const row of r.documents) expect(row.category).toBe("hr");
    }
  });

  it("client filters AND with the term scope — no widening", async () => {
    await grant("u1", "notes", ["id", "body", "category"], { field: "category", op: "in", value: ["hr"] });
    const r = await broker.query({ userId: "u1", env: "dev" },
      { collection: "notes", filters: [{ field: "category", op: "eq", value: "finance" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.length).toBe(0);
  });

  it("term field can gate rows without being readable (deny-style)", async () => {
    await grant("u2", "notes", ["id", "body"], { field: "category", op: "in", value: ["hr"] });
    const r = await broker.query({ userId: "u2", env: "dev" }, { collection: "notes" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documents.length).toBe(2);
      for (const row of r.documents) expect("category" in row).toBe(false);  // absent, not null
    }
    const denied = await broker.query({ userId: "u2", env: "dev" },
      { collection: "notes", fields: ["category"] });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("field_denied");
  });

  it("empty in-list denies all rows", async () => {
    await grant("u3", "notes", ["id", "body"], { field: "category", op: "in", value: [] });
    const r = await broker.query({ userId: "u3", env: "dev" }, { collection: "notes" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.length).toBe(0);
  });
});

describe("term-scoped grants: file search", () => {
  it("searchDocuments only reaches documents inside the term scope", async () => {
    await grant("u4", "briefs", ["title", "content", "category"],
      { field: "category", op: "in", value: ["hr"] });
    // "vacation" matches a document in BOTH files — only the hr one may return
    const r = await broker.searchDocuments({ userId: "u4", env: "dev" },
      { collection: "briefs", q: "vacation" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documents.length).toBeGreaterThan(0);
      for (const row of r.documents) {
        expect(row.category).toBe("hr");
        expect(row.title).toBe("Handbook");
      }
    }
  });

  it("broker.query on the bound file collection filters by term too", async () => {
    await grant("u4", "briefs", ["title", "content", "category"], { field: "category", op: "in", value: ["hr"] });
    const r = await broker.query({ userId: "u4", env: "dev" }, { collection: "briefs" });
    expect(r.ok).toBe(true);
    if (r.ok) for (const row of r.documents) expect(row.category).toBe("hr");
  });
});

describe("audit", () => {
  it("term-scoped calls are audited like any other", async () => {
    const n = (await admin.query(
      `select count(*)::int as n from app.audit_events where user_id in ('u1','u2','u3','u4')`)).rows[0].n;
    expect(n).toBeGreaterThan(0);
  });
});
