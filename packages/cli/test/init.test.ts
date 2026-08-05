import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadConfig } from "@warehousd/broker";
import { runInit, initDefaults } from "../src/init";

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

    const _r = await runInit(projectDir);
    const content = readFileSync(gitignorePath, "utf8");

    // Should have both entries
    expect(content).toContain(".warehousd/");
    expect(content).toContain("warehousd.local.yml");

    // Should have exactly one .warehousd/ line
    const count = (content.match(/\.warehousd\//g) || []).length;
    expect(count).toBe(1);
  });

  // The template ships the deploy block commented out, so a run with nothing to say about
  // deployment writes a config with no `deploy:` key rather than one naming a target nobody chose.
  it("leaves the deploy block commented when no target was named", async () => {
    await runInit(projectDir);
    expect(loadConfig(projectDir).deploy).toBeUndefined();
  });

  // The gate on this change: --no-input has to be able to specify every field the wizard collects,
  // and what it writes has to survive the same loader a hand-written file goes through.
  it("writes a loadable managed deploy block from --target alone", async () => {
    const { defaults, fromFlags } = initDefaults({ project: "harbor", target: "compose" });
    expect(fromFlags).toBe(true);
    await runInit(projectDir, { force: true, answers: defaults });

    const cfg = loadConfig(projectDir);
    expect(cfg.deploy).toEqual({
      target: "compose",
      app_name: "harbor",
      region: "local",
      database: { managed: true },
    });
  });

  it("writes a loadable url-and-provider deploy block from --target and --db-provider", async () => {
    process.env.PROD_DATABASE_URL = "postgres://u:p@db.abc.supabase.co:5432/postgres";
    const { defaults } = initDefaults({
      project: "Harbor Data",
      target: "railway",
      dbProvider: "supabase",
    });
    expect(defaults.deployManaged).toBe(false);
    await runInit(projectDir, { force: true, answers: defaults });

    const cfg = loadConfig(projectDir);
    expect(cfg.deploy).toEqual({
      target: "railway",
      app_name: "harbor-data",
      region: "us-west2",
      database: { url: process.env.PROD_DATABASE_URL, provider: "supabase" },
    });
    delete process.env.PROD_DATABASE_URL;
  });

  /**
   * The ordinary case, and the one a single shared flag made unscaffoldable: Docker locally,
   * somebody else's Postgres in production. `--db-provider` used to set one `managed` flag that
   * both blocks read, so naming a deploy provider rewrote the *local* database to
   * `${env:DATABASE_URL}` — a dev stack pointed at whatever that variable happened to hold.
   */
  it("leaves the local database block alone when only the deploy one is somebody else's", async () => {
    process.env.PROD_DATABASE_URL = "postgres://u:p@db.abc.supabase.co:5432/postgres";
    const { defaults } = initDefaults({
      project: "harbor",
      target: "fly",
      dbProvider: "supabase",
    });
    expect(defaults.managed).toBe(true);
    await runInit(projectDir, { force: true, answers: defaults });

    const written = readFileSync(join(projectDir, "warehousd.yml"), "utf8");
    expect(written).toContain("# database:");
    expect(written).toContain("#   managed: true");
    // Only the deploy block carries a url, and it is the production one.
    expect(written).toMatch(/^ {4}url: \$\{env:PROD_DATABASE_URL\}$/m);
    expect(written).not.toMatch(/^ {2}url: /m);

    const cfg = loadConfig(projectDir);
    expect(cfg.database).toBeUndefined();
    expect(cfg.deploy?.database).toEqual({
      url: process.env.PROD_DATABASE_URL,
      provider: "supabase",
    });
    delete process.env.PROD_DATABASE_URL;
  });

  // The other half of the split: a local database of your own says nothing about production, where
  // the target is still free to provision one.
  it("keeps a local url and a managed deploy database independent", async () => {
    await runInit(projectDir, {
      force: true,
      answers: {
        project: "harbor",
        port: 8722,
        managed: false,
        target: "fly",
        deployManaged: true,
        dbProvider: null,
      },
    });

    const cfg = loadConfig(projectDir);
    expect(cfg.database?.url).toBe(process.env.DATABASE_URL);
    expect(cfg.deploy?.database).toEqual({ managed: true });
  });

  it("refuses a provider with no target, since it would have no block to sit in", () => {
    expect(() => initDefaults({ project: "harbor", dbProvider: "neon" })).toThrow("--target");
  });

  it("refuses an unregistered target or provider, naming the ones that exist", () => {
    expect(() => initDefaults({ project: "harbor", target: "vercel" })).toThrow(
      /--target must be one of: fly, railway, compose/,
    );
    expect(() =>
      initDefaults({ project: "harbor", target: "fly", dbProvider: "planetscale" }),
    ).toThrow(/--db-provider must be one of: supabase, neon, railway, generic/);
  });

  it("overwrites warehousd.yml with --force", async () => {
    const _r1 = await runInit(projectDir);
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
