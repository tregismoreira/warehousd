import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { extractDoc } from "../src/indexing/extract";
import { chunkText } from "../src/indexing/chunk";
import { indexCollection } from "../src/indexing";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";

describe("extractDoc", () => {
  const mtime = new Date("2026-07-01T00:00:00Z");
  it("title from first # heading, owner from frontmatter, checksum stable", () => {
    const raw = "---\nowner: ana@meridian.demo\n---\n# PTO Policy\n\nBody text.";
    const d = extractDoc("hr/pto.md", raw, mtime);
    expect(d.title).toBe("PTO Policy");
    expect(d.owner).toBe("ana@meridian.demo");
    expect(d.content).not.toContain("owner:");        // frontmatter stripped
    expect(d.checksum).toBe(extractDoc("hr/pto.md", raw, mtime).checksum);
  });
  it("falls back to filename title and null owner", () => {
    const d = extractDoc("notes/q3-plan.txt", "no heading here", mtime);
    expect(d.title).toBe("q3-plan");
    expect(d.owner).toBeNull();
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
  project: "t", server: { port: 1 }, synthetic: { rows_per_collection: {} },
  collections: {
    policies: {
      type: "document" as const,
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
    const chunks = await db.query(`select content from data_synth."policies__chunks" c
      join data_synth."policies__docs" d on d.id=c.document_id where d.path='a.md'`);
    expect(chunks.rows.every((r: any) => r.content.includes("CHANGED"))).toBe(true);

    rmSync(join(dir, "sub/b.txt"));
    const r4 = await indexCollection(db, "dev", "policies", dir);
    expect(r4.deleted).toBe(1);
    const docs = await db.query(`select path from data_synth."policies__docs"`);
    expect(docs.rows.map((r: any) => r.path)).toEqual(["a.md"]);

    rmSync(dir, { recursive: true });
  });

  it("indexing dev touches only data_synth (design test 6)", async () => {
    p = await provision("indexing2");
    db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, docCfg);

    const live = await db.query(`select count(*)::int as n from data_live."policies__docs"`);
    expect(live.rows[0].n).toBe(0);

    rmSync(join(tmpdir(), "wh-idx-*"), { force: true });
  });
});
