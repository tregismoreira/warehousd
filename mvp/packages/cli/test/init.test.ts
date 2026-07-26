import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadConfig } from "@warehousd/broker";
import { runInit } from "../src/init";

describe("runInit", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wh-init-"));
    // Set DATABASE_URL so loadConfig can interpolate the template
    process.env.DATABASE_URL = "postgres://localhost/test";
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("creates warehousd.yml that loadConfig can parse", async () => {
    const r = await runInit(projectDir);
    expect(r.created).toContain("warehousd.yml");
    expect(r.skipped).not.toContain("warehousd.yml");

    // Verify file exists
    const ymlPath = join(projectDir, "warehousd.yml");
    expect(existsSync(ymlPath)).toBe(true);

    // Verify it can be loaded
    const cfg = loadConfig(projectDir);
    expect(cfg.project).toBeDefined();
    expect(cfg.server).toBeDefined();
    expect(cfg.server.port).toBe(8722);
    expect(cfg.collections).toBeDefined();
    expect(cfg.collections.announcements).toBeDefined();
  });

  it("appends warehousd.local.yml and .warehousd/ to .gitignore", async () => {
    await runInit(projectDir);

    const gitignorePath = join(projectDir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);

    const content = readFileSync(gitignorePath, "utf8");
    expect(content).toContain("warehousd.local.yml");
    expect(content).toContain(".warehousd/");
  });

  it("skips warehousd.yml on second run if it already exists", async () => {
    const r1 = await runInit(projectDir);
    expect(r1.created).toContain("warehousd.yml");
    expect(r1.skipped).not.toContain("warehousd.yml");

    // Modify the file to detect if it got overwritten
    const ymlPath = join(projectDir, "warehousd.yml");
    const originalContent = readFileSync(ymlPath, "utf8");
    const modifiedContent = originalContent.replace("my-app", "modified-app");
    writeFileSync(ymlPath, modifiedContent);

    // Run init again
    const r2 = await runInit(projectDir);
    expect(r2.skipped).toContain("warehousd.yml");
    expect(r2.created).not.toContain("warehousd.yml");

    // Verify file was not overwritten
    const finalContent = readFileSync(ymlPath, "utf8");
    expect(finalContent).toContain("modified-app");
  });

  it("does not add duplicate .gitignore lines on second run", async () => {
    await runInit(projectDir);

    const gitignorePath = join(projectDir, ".gitignore");
    const contentAfterFirst = readFileSync(gitignorePath, "utf8");
    const firstCount = (contentAfterFirst.match(/warehousd\.local\.yml/g) || []).length;
    const secondCount = (contentAfterFirst.match(/\.warehousd\//g) || []).length;

    // Run init again
    await runInit(projectDir);

    const contentAfterSecond = readFileSync(gitignorePath, "utf8");
    const firstCountAfter = (contentAfterSecond.match(/warehousd\.local\.yml/g) || []).length;
    const secondCountAfter = (contentAfterSecond.match(/\.warehousd\//g) || []).length;

    expect(firstCountAfter).toBe(firstCount);
    expect(secondCountAfter).toBe(secondCount);
  });

  it("with existing .gitignore that already contains .warehousd/, only appends missing line", async () => {
    // Create .gitignore with just .warehousd/
    const gitignorePath = join(projectDir, ".gitignore");
    writeFileSync(gitignorePath, ".warehousd/\n");

    const r = await runInit(projectDir);
    const content = readFileSync(gitignorePath, "utf8");

    // Should have both entries
    expect(content).toContain(".warehousd/");
    expect(content).toContain("warehousd.local.yml");

    // Should have exactly one .warehousd/ line
    const count = (content.match(/\.warehousd\//g) || []).length;
    expect(count).toBe(1);
  });

  it("overwrites warehousd.yml with --force", async () => {
    const r1 = await runInit(projectDir);
    const ymlPath = join(projectDir, "warehousd.yml");
    const originalContent = readFileSync(ymlPath, "utf8");
    const modifiedContent = originalContent.replace("my-app", "modified-app");
    writeFileSync(ymlPath, modifiedContent);

    // Run with force
    const r2 = await runInit(projectDir, { force: true });
    expect(r2.created).toContain("warehousd.yml");

    // Verify file was overwritten
    const finalContent = readFileSync(ymlPath, "utf8");
    expect(finalContent).toContain("my-app");
    expect(finalContent).not.toContain("modified-app");
  });
});
