import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWebDb } from "./helpers/web-db";

// Lives in its own file rather than alongside entrypoint.integration.test.ts: `auth` is a module
// singleton bound to the APP_DATABASE_URL present when it is first imported, so a second suite in
// the same file would still be talking to the first suite's dropped database.

// Harbor binds a dataset-sourced vocabulary (`client`, rows of `clients`) to a file collection
// that also declares `source_live`. Terms are env-scoped, and nothing populates data_live on a
// fresh deployment, so the live term set is empty — the shape the container actually boots into.
describe("entrypoint.bootstrap with a dataset-sourced vocabulary", () => {
  let fixture: string;
  let setup: Awaited<ReturnType<typeof setupWebDb>>;

  beforeAll(async () => {
    fixture = mkdtempSync(join(tmpdir(), "ent-src-"));
    await mkdir(join(fixture, "seed", "cases-dev"), { recursive: true });
    await mkdir(join(fixture, "seed", "cases-live"), { recursive: true });
    // The dev doc names a client the synthetic generator produces; the live doc names one that
    // only an import into data_live could create.
    await writeFile(
      join(fixture, "seed", "cases-dev", "matter.md"),
      "---\nclient: c-0001\n---\n# Dev Matter\nDev body.",
    );
    await writeFile(
      join(fixture, "seed", "cases-live", "matter.md"),
      "---\nclient: c-9001\n---\n# Live Matter\nLive body.",
    );

    await writeFile(
      join(fixture, "warehousd.yml"),
      `
project: test-entrypoint-src
server: { port: 8722 }
taxonomies:
  client:
    label: Client
    source: { collection: clients, slug: client_number, label: name }
collections:
  clients:
    description: Client directory
    fields:
      id:            { type: uuid, posture: allow, pk: true }
      client_number: { type: text, posture: allow, gen: client_number }
      name:          { type: text, posture: allow, gen: company_name }
  cases:
    type: file
    description: Case files
    source: ./seed/cases-dev
    source_live: ./seed/cases-live
    taxonomies: [client]
    fields:
      title:   { posture: allow }
      content: { posture: allow }
synthetic:
  documents_per_collection: { clients: 5 }
`,
    );

    setup = await setupWebDb("entrypoint-src");
    process.env.WAREHOUSD_PROJECT_DIR = fixture;
    process.env.APP_DATABASE_URL = setup.appUrl;
    process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-chars-long-000";
    process.env.BETTER_AUTH_URL ??= "http://localhost:8722";
    process.env.WAREHOUSD_ADMIN_EMAIL = "admin@test.local";
    process.env.WAREHOUSD_ADMIN_PASSWORD = "adminpass123";
    process.env.WAREHOUSD_DATA_ROLE_PASSWORD = "pw";
    process.env.WAREHOUSD_SEED = "42";
    process.env.WAREHOUSD_SKIP_BA_MIGRATE = "true";
    delete process.env.WAREHOUSD_DEMO;
  });

  afterAll(async () => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    if (setup) await setup.end();
  });

  it("boots with an empty live term set instead of throwing on an unknown term", async () => {
    const { bootstrap } = await import("../scripts/entrypoint");
    // Before this was guarded, indexing seed/cases-live threw `unknown client term "c-9001"`
    // and took the whole container down with it.
    await expect(bootstrap()).resolves.toBeUndefined();

    const db = new Pool({ connectionString: setup.appUrl });
    // Dev is fully indexed: syncDatasetTerms(dev) ran after generateSynthetic, so c-0001 resolves.
    const dev = await db.query(`select "client" from data_synth."cases__files"`);
    expect(dev.rowCount).toBe(1);
    expect(dev.rows[0].client).toBe("c-0001");
    // Live is skipped, not half-written.
    const live = await db.query(`select count(*) as cnt from data_live."cases__files"`);
    expect(Number(live.rows[0].cnt)).toBe(0);
    await db.end();
  });

  it("indexes live once the source collection has live rows", async () => {
    const { bootstrap } = await import("../scripts/entrypoint");
    const db = new Pool({ connectionString: setup.appUrl });
    // Stand in for an admin import of the client the live document references.
    await db.query(`insert into data_live.clients (id, client_number, name)
      values (gen_random_uuid(), 'C-9001', 'Beacon Manufacturing')`);
    await db.end();

    await bootstrap();

    const db2 = new Pool({ connectionString: setup.appUrl });
    const live = await db2.query(`select "client" from data_live."cases__files"`);
    expect(live.rowCount).toBe(1);
    expect(live.rows[0].client).toBe("c-9001");
    await db2.end();
  });
});
