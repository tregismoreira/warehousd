import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, writeSync } from "node:fs";
import { provision, type Provisioned } from "../../broker/test/helpers/db";
import { runIndex } from "../src/index";
import { createAppSchema } from "../../broker/src/db/migrate-app";
import { applyConfig } from "../../broker/src/apply/apply";

describe("runIndex env/source resolution", () => {
  let p: Provisioned;
  let projectDir: string;
  let dirWithoutSourceLive: string;
  let dbUrl: string;

  beforeAll(async () => {
    p = await provision("cli-index");
    dbUrl = p.urls.admin;

    // Create projectDir fixture with both source and source_live
    projectDir = mkdtempSync(join(tmpdir(), "wh-cli-idx-"));
    const docsDevDir = join(projectDir, "docs-dev");
    const docsLiveDir = join(projectDir, "docs-live");
    mkdirSync(docsDevDir);
    mkdirSync(docsLiveDir);

    // Write distinct content to each
    writeFileSync(join(docsDevDir, "policy.md"), "# Dev Policy\n\nThis is dev content");
    writeFileSync(join(docsLiveDir, "policy.md"), "# Live Policy\n\nThis is live content");

    // Create warehousd.yml with document collection and structured collection
    const config = `
project: test-cli
server:
  port: 8722
collections:
  policies:
    type: document
    description: Policy documents
    source: ./docs-dev
    source_live: ./docs-live
    fields:
      title:
        posture: allow
      content:
        posture: allow
      path:
        posture: deny
  people:
    description: People records
    type: structured
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      email:
        type: text
        posture: allow
`;
    writeFileSync(join(projectDir, "warehousd.yml"), config);

    // Provision and apply config
    const db = new Pool({ connectionString: dbUrl });
    await createAppSchema(db);
    const cfg = {
      project: "test-cli",
      server: { port: 8722 },
      synthetic: { rows_per_collection: {} },
      collections: {
        policies: {
          type: "document" as const,
          description: "Policy documents",
          source: "./docs-dev",
          source_live: "./docs-live",
          fields: {
            title: { posture: "allow" as const },
            content: { posture: "allow" as const },
            path: { posture: "deny" as const },
          },
        },
        people: {
          description: "People records",
          fields: {
            id: { type: "uuid" as const, posture: "allow" as const, pk: true },
            email: { type: "text" as const, posture: "allow" as const },
          },
        },
      },
    };
    await applyConfig(db, cfg);
    await db.end();

    // Create dirWithoutSourceLive fixture
    dirWithoutSourceLive = mkdtempSync(join(tmpdir(), "wh-cli-idx-no-live-"));
    const docsDevDir2 = join(dirWithoutSourceLive, "docs-dev");
    mkdirSync(docsDevDir2);
    writeFileSync(join(docsDevDir2, "policy.md"), "# Dev Policy\n\nThis is dev content");

    const config2 = `
project: test-cli
server:
  port: 8722
collections:
  policies:
    type: document
    description: Policy documents
    source: ./docs-dev
    fields:
      title:
        posture: allow
      content:
        posture: allow
      path:
        posture: deny
  people:
    description: People records
    type: structured
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      email:
        type: text
        posture: allow
`;
    writeFileSync(join(dirWithoutSourceLive, "warehousd.yml"), config2);
  });

  afterAll(async () => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(dirWithoutSourceLive, { recursive: true, force: true });
    await p?.end();
  });

  it("defaults to env=dev and the YAML source dir", async () => {
    const r = await runIndex(projectDir, dbUrl, "policies", {});
    expect(r.indexed).toBe(1);
    const db = new Pool({ connectionString: dbUrl });
    const synth = await db.query(`select count(*)::int as n from data_synth."policies__docs"`);
    const live = await db.query(`select count(*)::int as n from data_live."policies__docs"`);
    expect(synth.rows[0].n).toBe(1);
    expect(live.rows[0].n).toBe(0);
    await db.end();
  });

  it("env=live uses source_live", async () => {
    await runIndex(projectDir, dbUrl, "policies", { env: "live" });
    const db = new Pool({ connectionString: dbUrl });
    const live = await db.query(`select content from data_live."policies__docs" join data_live."policies__chunks" on data_live."policies__chunks".document_id = data_live."policies__docs".id limit 1`);
    const synth = await db.query(`select content from data_synth."policies__docs" join data_synth."policies__chunks" on data_synth."policies__chunks".document_id = data_synth."policies__docs".id limit 1`);
    expect(live.rowCount).toBe(1);
    expect(synth.rowCount).toBe(1);
    // The content should be different because dev uses docs-dev and live uses docs-live
    expect(live.rows[0].content).toContain("live content");
    expect(synth.rows[0].content).toContain("dev content");
    await db.end();
  });

  it("env=live with neither source_live nor --source throws (never silently reuses dev source)", async () => {
    const db = new Pool({ connectionString: dbUrl });
    // Setup schema for dirWithoutSourceLive
    const cfg2 = {
      project: "test-cli",
      server: { port: 8722 },
      synthetic: { rows_per_collection: {} },
      collections: {
        policies: {
          type: "document" as const,
          description: "Policy documents",
          source: "./docs-dev",
          fields: {
            title: { posture: "allow" as const },
            content: { posture: "allow" as const },
            path: { posture: "deny" as const },
          },
        },
        people: {
          description: "People records",
          fields: {
            id: { type: "uuid" as const, posture: "allow" as const, pk: true },
            email: { type: "text" as const, posture: "allow" as const },
          },
        },
      },
    };
    await applyConfig(db, cfg2);
    await db.end();

    await expect(runIndex(dirWithoutSourceLive, dbUrl, "policies", { env: "live" }))
      .rejects.toThrow(/source_live|--source/);
  });

  it("rejects a structured collection", async () => {
    await expect(runIndex(projectDir, dbUrl, "people", {}))
      .rejects.toThrow(/document/);
  });
});
