import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectBundlePaths, writeBundle } from "../src/deploy/bundle";
import { loadConfig } from "@warehousd/broker";

describe("collectBundlePaths", () => {
  it("includes warehousd.yml", () => {
    const harborDir = join(process.cwd(), "examples/harbor");
    const cfg = loadConfig(harborDir);
    const paths = collectBundlePaths(cfg);
    expect(paths).toContain("warehousd.yml");
  });

  it("includes all collection source directories from harbor (3 file collections)", () => {
    const harborDir = join(process.cwd(), "examples/harbor");
    const cfg = loadConfig(harborDir);
    const paths = collectBundlePaths(cfg);
    expect(paths).toContain("./seed/docs-dev");
    expect(paths).toContain("./seed/case-files-dev");
    expect(paths).toContain("./seed/precedents-dev");
  });

  it("excludes source_live directories from harbor explicitly", () => {
    const harborDir = join(process.cwd(), "examples/harbor");
    const cfg = loadConfig(harborDir);
    const paths = collectBundlePaths(cfg);
    expect(paths).not.toContain("./seed/docs-live");
    expect(paths).not.toContain("./seed/case-files-live");
    expect(paths).not.toContain("./seed/precedents-live");
  });

  it("returns a stable sorted order for reproducibility", () => {
    const harborDir = join(process.cwd(), "examples/harbor");
    const cfg = loadConfig(harborDir);
    const paths1 = collectBundlePaths(cfg);
    const paths2 = collectBundlePaths(cfg);
    expect(paths1).toEqual(paths2);
    // Verify it's sorted
    const sorted = [...paths1].sort();
    expect(paths1).toEqual(sorted);
  });

  it("deduplicates paths from multiple collections sharing a source", () => {
    const harborDir = join(process.cwd(), "examples/harbor");
    const cfg = loadConfig(harborDir);
    const paths = collectBundlePaths(cfg);
    // warehousd.yml appears once even though it's always included
    const warehousdCount = paths.filter((p) => p === "warehousd.yml").length;
    expect(warehousdCount).toBe(1);
  });
});

describe("writeBundle", () => {
  it("creates files in outDir with correct structure", () => {
    const harborDir = join(process.cwd(), "examples/harbor");
    const cfg = loadConfig(harborDir);
    const outDir = join(tmpdir(), `warehousd-test-${Date.now()}`);

    writeBundle(cfg, harborDir, outDir);

    // Check that warehousd.yml was copied
    expect(existsSync(join(outDir, "warehousd.yml"))).toBe(true);
    // Check that dev source dirs were copied
    expect(existsSync(join(outDir, "seed/docs-dev"))).toBe(true);
    expect(existsSync(join(outDir, "seed/case-files-dev"))).toBe(true);
    expect(existsSync(join(outDir, "seed/precedents-dev"))).toBe(true);

    rmSync(outDir, { recursive: true, force: true });
  });

  it("excludes source_live directories", () => {
    const harborDir = join(process.cwd(), "examples/harbor");
    const cfg = loadConfig(harborDir);
    const outDir = join(tmpdir(), `warehousd-test-${Date.now()}`);

    writeBundle(cfg, harborDir, outDir);

    // Explicitly check that live dirs are NOT present
    expect(existsSync(join(outDir, "seed/docs-live"))).toBe(false);
    expect(existsSync(join(outDir, "seed/case-files-live"))).toBe(false);
    expect(existsSync(join(outDir, "seed/precedents-live"))).toBe(false);

    rmSync(outDir, { recursive: true, force: true });
  });

  it("clears outDir before writing to prevent leftover files from previous deploys", () => {
    const harborDir = join(process.cwd(), "examples/harbor");
    const cfg = loadConfig(harborDir);
    const outDir = join(tmpdir(), `warehousd-test-${Date.now()}`);

    // First write
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "leftover.txt"), "should be deleted");

    // Second write
    writeBundle(cfg, harborDir, outDir);

    // leftover.txt should be gone
    expect(existsSync(join(outDir, "leftover.txt"))).toBe(false);
    // But warehousd.yml should exist
    expect(existsSync(join(outDir, "warehousd.yml"))).toBe(true);

    rmSync(outDir, { recursive: true, force: true });
  });

  it("excludes warehousd.local.yml when present in fixture", () => {
    // Create a minimal test fixture
    const testDir = join(tmpdir(), `warehousd-fixture-${Date.now()}`);
    const outDir = join(testDir, "deploy");

    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, "warehousd.yml"),
      "project: test\nserver: { port: 8722 }\ncollections:\n  items:\n    description: Items\n    fields:\n      id: { type: uuid, posture: allow, pk: true }\n",
    );
    writeFileSync(join(testDir, "warehousd.local.yml"), "demo: true\n");

    const cfg = loadConfig(testDir);
    writeBundle(cfg, testDir, outDir);

    // warehousd.local.yml must not appear in the bundle
    expect(existsSync(join(outDir, "warehousd.local.yml"))).toBe(false);

    rmSync(testDir, { recursive: true, force: true });
  });
});
