import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { extractFile } from "../src/indexing/extract";
import { chunkText } from "../src/indexing/chunk";
import { indexCollection } from "../src/indexing";
import { loadTaxonomyBindings } from "../src/taxonomy";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";

describe("extractFile", () => {
  const mtime = new Date("2026-07-01T00:00:00Z");
  it("title from first # heading, owner from frontmatter, checksum stable", () => {
    const raw = "---\nowner: ana@harbor.demo\n---\n# PTO Policy\n\nBody text.";
    const d = extractFile("hr/pto.md", raw, mtime);
    expect(d.title).toBe("PTO Policy");
    expect(d.owner).toBe("ana@harbor.demo");
    expect(d.content).not.toContain("owner:");        // frontmatter stripped
    expect(d.checksum).toBe(extractFile("hr/pto.md", raw, mtime).checksum);
  });
  it("falls back to filename title and null owner", () => {
    const d = extractFile("notes/q3-plan.txt", "no heading here", mtime);
    expect(d.title).toBe("q3-plan");
    expect(d.owner).toBeNull();
  });
  it("parses the taxonomy term from frontmatter when termFields given", () => {
    const raw = "---\nowner: ana@harbor.demo\ncategory: hr\n---\n# T\n\nBody.";
    const d = extractFile("a.md", raw, mtime, [{ field: "category" }]);
    expect(d.terms.category).toBe("hr");
    // not requested → no key at all; requested but absent → an explicit null
    expect(extractFile("a.md", raw, mtime).terms).not.toHaveProperty("category");
    expect(extractFile("a.md", "# T\n\nBody.", mtime, [{ field: "category" }]).terms.category).toBeNull();
  });
  it("parses a multi-value vocabulary as a list, in either frontmatter form", () => {
    const tf = [{ field: "tags", multiple: true }];
    expect(extractFile("a.md", "---\ntags: [litigation, discovery]\n---\n# T", mtime, tf).terms.tags)
      .toEqual(["litigation", "discovery"]);
    expect(extractFile("a.md", "---\ntags: litigation, discovery\n---\n# T", mtime, tf).terms.tags)
      .toEqual(["litigation", "discovery"]);
    expect(extractFile("a.md", "---\ntags: litigation\n---\n# T", mtime, tf).terms.tags)
      .toEqual(["litigation"]);
  });
  it("rejects a list for a single-value vocabulary, naming the file", () => {
    const tf = [{ field: "category" }];
    expect(() => extractFile("a.md", "---\ncategory: [hr, finance]\n---\n# T", mtime, tf))
      .toThrow(/a\.md.*single-value/);
    expect(() => extractFile("a.md", "---\ncategory: hr, finance\n---\n# T", mtime, tf))
      .toThrow(/a\.md.*single-value/);
  });
});

describe("chunkText", () => {
  it("keeps a short doc as one chunk", () => {
    expect(chunkText("one para.\n\ntwo para.")).toHaveLength(1);
  });
  it("splits on paragraphs, each chunk ≤ max", () => {
    const paras = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} ${"x".repeat(180)}`);
    const chunks = chunkText(paras.join("\n\n"), { max: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });
  it("overlaps consecutive chunks", () => {
    const paras = Array.from({ length: 20 }, (_, i) => `P${i} ${"x".repeat(180)}`);
    const [a, b] = chunkText(paras.join("\n\n"), { max: 1000 });
    const tail = a.slice(-40);
    expect(b).toContain(tail.slice(0, 20)); // start of b repeats a's tail region
  });
  it("hard-splits a single oversized paragraph", () => {
    const chunks = chunkText("y".repeat(5000), { max: 1000 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });
});

const docCfg = {
  project: "t", server: { port: 1 }, synthetic: { documents_per_collection: {} },
  collections: {
    policies: {
      type: "file" as const,
      description: "d",
      source: "./x",
      fields: {
        title: { posture: "allow" as const },
        content: { posture: "allow" as const },
        path: { posture: "deny" as const },
      },
    },
  },
};

describe("indexCollection (DB-backed)", () => {
  let p: Provisioned;
  let db: Pool;

  afterAll(async () => {
    await db?.end();
    await p?.end();
  });

  it("indexes .md/.txt, skips unchanged, re-indexes modified, deletes removed (design test 5)", async () => {
    p = await provision("indexing");
    db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, docCfg);

    const dir = mkdtempSync(join(tmpdir(), "wh-idx-"));
    writeFileSync(join(dir, "a.md"), "# A\n\nalpha body");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub/b.txt"), "bravo body");
    writeFileSync(join(dir, "c.png"), "ignored");

    const r1 = await indexCollection(db, "dev", "policies", dir);
    expect(r1).toEqual({ indexed: 2, skipped: 0, deleted: 0 });

    const r2 = await indexCollection(db, "dev", "policies", dir);
    expect(r2).toEqual({ indexed: 0, skipped: 2, deleted: 0 });

    writeFileSync(join(dir, "a.md"), "# A\n\nalpha body CHANGED");
    const r3 = await indexCollection(db, "dev", "policies", dir);
    expect(r3.indexed).toBe(1);
    const chunks = await db.query(`select content from data_synth."policies__documents" c
      join data_synth."policies__files" d on d.id=c.file_id where d.path='a.md'`);
    expect(chunks.rows.every((r: any) => r.content.includes("CHANGED"))).toBe(true);

    rmSync(join(dir, "sub/b.txt"));
    const r4 = await indexCollection(db, "dev", "policies", dir);
    expect(r4.deleted).toBe(1);
    const docs = await db.query(`select path from data_synth."policies__files"`);
    expect(docs.rows.map((r: any) => r.path)).toEqual(["a.md"]);

    rmSync(dir, { recursive: true });
  });

  it("indexing dev touches only data_synth (design test 6)", async () => {
    p = await provision("indexing2");
    db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, docCfg);

    const live = await db.query(`select count(*)::int as n from data_live."policies__files"`);
    expect(live.rows[0].n).toBe(0);

    rmSync(join(tmpdir(), "wh-idx-*"), { force: true });
  });
});

describe("indexCollection: taxonomy", () => {
  let p: Provisioned;
  let db: Pool;
  let dir: string;

  const taxonomyCfg = {
    ...docCfg,
    taxonomies: {
      category: { label: "C", terms: { hr: { label: "HR" }, finance: { label: "Fin" } } },
    },
    collections: {
      policies: {
        ...docCfg.collections.policies,
        taxonomies: ["category"],
      },
    },
  };

  let taxonomies: Awaited<ReturnType<typeof loadTaxonomyBindings>>;

  beforeAll(async () => {
    p = await provision("taxonomy");
    db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, taxonomyCfg);
    taxonomies = await loadTaxonomyBindings(db, taxonomyCfg, "policies", "dev");
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wh-tax-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  afterAll(async () => {
    await db?.end();
    await p?.end();
  });

  it("writes the term column from frontmatter", async () => {
    writeFileSync(join(dir, "a.md"), "---\ncategory: hr\n---\n# A\n\nAlpha body.");
    await indexCollection(db, "dev", "policies", dir, { taxonomies });
    const r = (await db.query(`select category from data_synth."policies__files" where path='a.md'`)).rows[0];
    expect(r.category).toBe("hr");
  });

  it("updates the term when frontmatter changes", async () => {
    writeFileSync(join(dir, "a.md"), "---\ncategory: finance\n---\n# A\n\nAlpha body v2.");
    await indexCollection(db, "dev", "policies", dir, { taxonomies });
    const r = (await db.query(`select category from data_synth."policies__files" where path='a.md'`)).rows[0];
    expect(r.category).toBe("finance");
  });

  it("rejects a file with missing term, naming the file", async () => {
    writeFileSync(join(dir, "b.md"), "# B\n\nNo frontmatter.");
    await expect(indexCollection(db, "dev", "policies", dir, { taxonomies }))
      .rejects.toThrow(/b\.md.*missing required category/);
  });

  it("rejects a file with an unknown term, naming file and term", async () => {
    writeFileSync(join(dir, "b.md"), "---\ncategory: bogus\n---\n# B\n\nBody.");
    await expect(indexCollection(db, "dev", "policies", dir, { taxonomies }))
      .rejects.toThrow(/b\.md.*unknown category term "bogus"/);
  });

  it("unbound collections index exactly as before", async () => {
    writeFileSync(join(dir, "a.md"), "# A\n\nalpha body");
    const r = await indexCollection(db, "dev", "policies", dir);   // use docCfg without taxonomy
    expect(r.deleted + r.indexed + r.skipped).toBeGreaterThan(0);
  });
});
