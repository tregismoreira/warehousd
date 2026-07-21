import { describe, it, expect } from "vitest";
import { extractDoc } from "../src/indexing/extract";
import { chunkText } from "../src/indexing/chunk";

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
