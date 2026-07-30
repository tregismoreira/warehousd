import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { assertSchema } from "./helpers/results";

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    articles: {
      description: "Articles",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: "allow", searchable: true },
        summary: { type: "text", posture: "allow" },
        body: { type: "text", posture: "allow", searchable: true },
        category: { type: "text", posture: "allow" },
      },
    },
    unsearchable: {
      description: "No searchable fields",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        name: { type: "text", posture: "allow" },
      },
    },
  },
});

let p: Provisioned;
let db: Pool;
let pools: Pools;
let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("searchable");
  db = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(db);
  await applyConfig(db, cfg);

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);

  // Seed articles (use admin pool, not dev pool which has no INSERT)
  await db.query(
    `insert into data_synth.articles (id, title, summary, body, category) values
     (gen_random_uuid(), 'GraphQL API Design', 'Best practices', 'GraphQL is powerful', 'tech'),
     (gen_random_uuid(), 'REST API Best Practices', 'REST design', 'REST is simple', 'tech'),
     (gen_random_uuid(), 'Company Handbook', 'About us', 'We value teamwork', 'hr')`,
  );

  // Setup grant
  await db.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ($1, $2, $3, $4, $5)`,
    ["u1", "articles", ["id", "title", "summary", "body", "category"], "dev", "approved"],
  );
  await db.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ($1, $2, $3, $4, $5)`,
    ["u2", "unsearchable", ["id", "name"], "dev", "approved"],
  );
});

afterAll(async () => {
  await db.end();
  await pools.end();
  await p.end();
});

it("searchable: true on a dataset text field makes searchDocuments return rows", async () => {
  const r = await broker.searchDocuments(makeCtx({ userId: "u1" }), {
    collection: "articles",
    q: "GraphQL",
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.documents.length).toBeGreaterThan(0);
    // Should match "GraphQL API Design" in title (searchable)
    const titles = r.documents.map((d) => d.title);
    expect(titles.some((t) => (t as string).includes("GraphQL"))).toBe(true);
  }
});

it("a non-searchable text field on the same collection is not matched", async () => {
  // Search for "About us" which is in summary, but summary is not searchable
  const r = await broker.searchDocuments(makeCtx({ userId: "u1" }), {
    collection: "articles",
    q: "About us",
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    // Should not match because summary is not searchable
    expect(r.documents.length).toBe(0);
  }
});

it("body is searchable, so should match", async () => {
  const r = await broker.searchDocuments(makeCtx({ userId: "u1" }), {
    collection: "articles",
    q: "simple",
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    // Should match "REST is simple" in body
    expect(r.documents.length).toBeGreaterThan(0);
  }
});

it("a dataset with no searchable field still refuses invalid_intent", async () => {
  const r = await broker.searchDocuments(makeCtx({ userId: "u2" }), {
    collection: "unsearchable",
    q: "anything",
  });
  expect(r).toMatchObject({ ok: false, reason: "invalid_intent" });
});

it("<f>_tsv never appears in describe_collection output", async () => {
  const r = await broker.describeCollection(makeCtx({ userId: "u1" }), "articles");
  assertSchema(r);
  {
    const fieldNames = r.fields.map((f) => f.name);
    expect(fieldNames).not.toContain("title_tsv");
    expect(fieldNames).not.toContain("body_tsv");
    expect(fieldNames).toContain("title");
    expect(fieldNames).toContain("body");
  }
});

it("<f>_tsv never appears in a result row's fieldsReturned", async () => {
  const r = await broker.searchDocuments(makeCtx({ userId: "u1" }), {
    collection: "articles",
    q: "GraphQL",
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.fieldsReturned).not.toContain("title_tsv");
    expect(r.fieldsReturned).not.toContain("body_tsv");
    // But the actual documents shouldn't have those keys either
    for (const doc of r.documents) {
      expect(doc).not.toHaveProperty("title_tsv");
      expect(doc).not.toHaveProperty("body_tsv");
    }
  }
});

it("searchable on a non-text field is a config error", () => {
  const result = ConfigSchema.safeParse({
    project: "test",
    collections: {
      bad: {
        description: "Bad",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          count: { type: "int", posture: "allow", searchable: true },
        },
      },
    },
  });
  expect(result.success).toBe(false);
});

it("searchable on a file collection is a config error", () => {
  const result = ConfigSchema.safeParse({
    project: "test",
    collections: {
      docs: {
        type: "file",
        description: "Docs",
        source: "./x",
        fields: {
          title: { posture: "allow", searchable: true },
          content: { posture: "allow" },
          path: { posture: "deny" },
        },
      },
    },
  });
  expect(result.success).toBe(false);
});
