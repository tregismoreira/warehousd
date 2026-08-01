import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import {
  createAppSchema,
  applyConfig,
  createPools,
  indexCollection,
  syncDatasetTerms,
  loadTaxonomyBindings,
  DEFAULT_ORG_ID,
  type Pools,
} from "../src/index";
import { loadConfig } from "../src/config/load";
import { grantViewDDL, viewDDL } from "../src/apply/ddl";
import {
  countDocuments,
  countDocumentsIn,
  countTermUsage,
  listFiles,
} from "../src/documents/inventory";

let p: Provisioned, admin: Pool, pools: Pools;
const harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
const cfg = loadConfig(harborDir);

const OTHER_ORG = "org-tenant-b";
const dev = { env: "dev", orgId: DEFAULT_ORG_ID } as const;
const live = { env: "live", orgId: DEFAULT_ORG_ID } as const;
const otherDev = { env: "dev", orgId: OTHER_ORG } as const;

const DEV_VENDORS = 3;
const LIVE_VENDORS = 5;
const TENANT_B_DOCUMENTS = 2;

async function seedVendors(schema: string, n: number) {
  for (let i = 0; i < n; i++) {
    await admin.query(
      `insert into ${schema}.vendors (org_id, id, name, category, tax_id, active)
       values ($1, gen_random_uuid(), $2, 'supplies', 'x', true)`,
      [DEFAULT_ORG_ID, `Vendor ${i}`],
    );
  }
}

beforeAll(async () => {
  p = await provision("inventory");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);

  await syncDatasetTerms(admin, cfg, "dev");
  await indexCollection(admin, "dev", "policies", `${harborDir}/seed/docs-dev`, {
    taxonomies: await loadTaxonomyBindings(admin, cfg, "policies", "dev"),
  });
  await syncDatasetTerms(admin, cfg, "live");
  await indexCollection(admin, "live", "policies", `${harborDir}/seed/docs-live`, {
    taxonomies: await loadTaxonomyBindings(admin, cfg, "policies", "live"),
  });

  // Deliberately different counts per environment: dev and live are separate schemas served by
  // separate roles, and the console's whole claim is that the switcher changes what you see.
  await seedVendors("data_synth", DEV_VENDORS);
  await seedVendors("data_live", LIVE_VENDORS);

  // A second tenant, written straight in. Org isolation on the data plane is enforced by the
  // view's own predicate, so what this proves is that these functions go through it.
  const fileId = "11111111-1111-1111-1111-111111111111";
  await admin.query(
    `insert into data_synth."policies__files" (id, org_id, title, path, owner, checksum, updated_at, department, tags)
     values ($1, $2, 'Tenant B handbook', 'tenant-b/handbook.md', 'b@example.com', 'cafef00d', now(), 'finance', array['compliance','tax'])`,
    [fileId, OTHER_ORG],
  );
  for (let seq = 0; seq < TENANT_B_DOCUMENTS; seq++) {
    await admin.query(
      `insert into data_synth."policies__documents" (id, org_id, file_id, document_seq, content)
       values (gen_random_uuid(), $1, $2, $3, 'tenant b content')`,
      [OTHER_ORG, fileId, seq],
    );
  }

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
}, 90_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

describe("countDocuments", () => {
  it("counts per environment, and the two differ", async () => {
    expect(await countDocuments(pools, dev, cfg, "vendors")).toBe(DEV_VENDORS);
    expect(await countDocuments(pools, live, cfg, "vendors")).toBe(LIVE_VENDORS);
  });

  it("counts a file collection's documents, not its files", async () => {
    const files = await listFiles(pools, dev, cfg, "policies");
    const total = files.reduce((n, f) => n + f.documentCount, 0);
    expect(files.length).toBeGreaterThan(0);
    expect(await countDocuments(pools, dev, cfg, "policies")).toBe(total);
  });

  it("throws on a collection the config does not declare", async () => {
    await expect(countDocuments(pools, dev, cfg, "nope")).rejects.toThrow(/Unknown collection/);
  });
});

describe("countDocumentsIn", () => {
  it("answers for several collections at once", async () => {
    const counts = await countDocumentsIn(pools, dev, cfg, ["vendors", "policies"]);
    expect(counts.vendors).toBe(DEV_VENDORS);
    expect(counts.policies).toBeGreaterThan(0);
  });

  it("returns {} for an empty list without touching the database", async () => {
    expect(await countDocumentsIn(pools, dev, cfg, [])).toEqual({});
  });

  // A collection declared but never applied to this environment has no view. A `select` against
  // it aborts the transaction in Postgres, so without the existence check every count after the
  // first miss would be lost too — which is exactly what the collections list would hit on a
  // half-applied stack.
  it("omits a collection with no view here, and still counts its neighbours", async () => {
    await admin.query(`drop view data_synth.v_expenses`);
    try {
      const counts = await countDocumentsIn(pools, dev, cfg, ["vendors", "expenses", "policies"]);
      expect("expenses" in counts).toBe(false);
      expect(counts.vendors).toBe(DEV_VENDORS);
      expect(counts.policies).toBeGreaterThan(0);
    } finally {
      // Put it back through the same DDL apply uses, so this test cannot leave behind a view
      // that only resembles the real one.
      await admin.query(viewDDL("dev", "expenses", cfg));
      await admin.query(grantViewDDL("dev", "expenses"));
    }
  });
});

describe("listFiles", () => {
  it("returns one row per file with its document count", async () => {
    const files = await listFiles(pools, dev, cfg, "policies");
    const paths = files.map((f) => f.path);
    expect(new Set(paths).size).toBe(files.length);
    expect(paths).toContain("remote-work.md");

    const file = files.find((f) => f.path === "remote-work.md")!;
    expect(file.documentCount).toBeGreaterThan(0);
    expect(file.checksum).toMatch(/^[0-9a-f]+$/);
    expect(file.title).toBeTruthy();
    expect(() => new Date(file.updated_at).toISOString()).not.toThrow();
  });

  it("lists different files per environment", async () => {
    const devFiles = (await listFiles(pools, dev, cfg, "policies")).map((f) => f.path);
    const liveFiles = (await listFiles(pools, live, cfg, "policies")).map((f) => f.path);
    expect(liveFiles).toContain("security.md");
    expect(devFiles).not.toContain("security.md");
  });

  it("throws on a dataset collection rather than guessing a table name", async () => {
    await expect(listFiles(pools, dev, cfg, "vendors")).rejects.toThrow(/not a file collection/);
  });

  it("throws on an unknown collection", async () => {
    await expect(listFiles(pools, dev, cfg, "nope")).rejects.toThrow(/Unknown collection/);
  });
});

describe("countTermUsage", () => {
  it("counts a single-value vocabulary, and the terms account for every document", async () => {
    const usage = await countTermUsage(pools, dev, cfg, "policies", "department");
    const total = Object.values(usage).reduce((a, b) => a + b, 0);
    // Every indexed document carries exactly one department — the indexer refuses a file whose
    // bound vocabulary is missing — so the counts partition the collection.
    expect(total).toBe(await countDocuments(pools, dev, cfg, "policies"));
    expect(Object.keys(usage).length).toBeGreaterThan(0);
  });

  it("unnests a multi-value vocabulary instead of counting arrays", async () => {
    const usage = await countTermUsage(pools, dev, cfg, "policies", "tags");
    const total = Object.values(usage).reduce((a, b) => a + b, 0);
    const documents = await countDocuments(pools, dev, cfg, "policies");
    // A document may carry several tags, so the terms over-count the collection rather than
    // partitioning it. Counting the text[] column directly would instead have produced one
    // bucket per distinct *array*, which is the bug this branch exists to avoid.
    expect(total).toBeGreaterThan(documents);
    for (const n of Object.values(usage)) expect(n).toBeLessThanOrEqual(documents);
  });

  it("counts per environment", async () => {
    const devUsage = await countTermUsage(pools, dev, cfg, "policies", "department");
    const liveUsage = await countTermUsage(pools, live, cfg, "policies", "department");
    expect(devUsage).not.toEqual(liveUsage);
  });

  it("refuses a vocabulary this collection does not bind", async () => {
    await expect(countTermUsage(pools, dev, cfg, "policies", "client")).rejects.toThrow(
      /does not bind vocabulary/,
    );
  });

  it("throws on an unknown collection", async () => {
    await expect(countTermUsage(pools, dev, cfg, "nope", "department")).rejects.toThrow(
      /Unknown collection/,
    );
  });
});

describe("org isolation", () => {
  it("counts only the caller's org", async () => {
    expect(await countDocuments(pools, otherDev, cfg, "policies")).toBe(TENANT_B_DOCUMENTS);
    expect(await countDocuments(pools, dev, cfg, "policies")).toBeGreaterThan(TENANT_B_DOCUMENTS);
  });

  it("lists only the caller's org's files", async () => {
    const theirs = await listFiles(pools, otherDev, cfg, "policies");
    const mine = await listFiles(pools, dev, cfg, "policies");
    expect(theirs.map((f) => f.path)).toEqual(["tenant-b/handbook.md"]);
    expect(mine.map((f) => f.path)).not.toContain("tenant-b/handbook.md");
  });

  it("counts terms only within the caller's org", async () => {
    const theirs = await countTermUsage(pools, otherDev, cfg, "policies", "department");
    expect(theirs).toEqual({ finance: TENANT_B_DOCUMENTS });

    const theirTags = await countTermUsage(pools, otherDev, cfg, "policies", "tags");
    expect(theirTags).toEqual({ compliance: TENANT_B_DOCUMENTS, tax: TENANT_B_DOCUMENTS });
  });

  it("does not leak the other org's documents into the default org's term counts", async () => {
    const mine = await countTermUsage(pools, dev, cfg, "policies", "tags");
    const total = Object.values(mine).reduce((a, b) => a + b, 0);
    const theirs = await countTermUsage(pools, otherDev, cfg, "policies", "tags");
    const theirTotal = Object.values(theirs).reduce((a, b) => a + b, 0);
    const both = await countTermUsage(
      pools,
      { env: "dev", orgId: "no-such-org" },
      cfg,
      "policies",
      "tags",
    );
    expect(both).toEqual({});
    expect(total).toBeGreaterThan(0);
    expect(theirTotal).toBe(TENANT_B_DOCUMENTS * 2);
  });
});
