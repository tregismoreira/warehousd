import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setupWebDb } from "./helpers/web-db";
import {
  loadConfig,
  makeBroker,
  createPools,
  requestGrant,
  approveGrant,
  SEED_REV_COLUMNS,
  SEED_REV_VALUES,
} from "@warehousd/broker";
import { makeCtx } from "../../../packages/broker/test/helpers/ctx";
import { assertApplied, assertPending } from "../../../packages/broker/test/helpers/results";

describe("entrypoint.bootstrap", () => {
  let fixture: string;
  let setup: Awaited<ReturnType<typeof setupWebDb>>;

  beforeAll(async () => {
    // Create a temp fixture project with one dataset collection and one file collection
    fixture = mkdtempSync(join(tmpdir(), "ent-"));
    await mkdir(join(fixture, "seed", "docs-dev"), { recursive: true });
    await mkdir(join(fixture, "seed", "docs-live"), { recursive: true });

    // Two markdown files for the file collection
    await writeFile(
      join(fixture, "seed", "docs-dev", "policy1.md"),
      "# Policy 1\nContent for policy 1",
    );
    await writeFile(
      join(fixture, "seed", "docs-dev", "policy2.md"),
      "# Policy 2\nContent for policy 2",
    );
    await writeFile(
      join(fixture, "seed", "docs-live", "policy1.md"),
      "# Policy 1 Live\nContent for live policy 1",
    );
    await writeFile(
      join(fixture, "seed", "docs-live", "policy2.md"),
      "# Policy 2 Live\nContent for live policy 2",
    );

    // Minimal warehousd.yml with one dataset and one file collection
    const yaml = `
project: test-entrypoint
server: { port: 8722 }
taxonomies:
  category:
    label: Category
    terms:
      general: { label: General }
collections:
  items:
    description: Test dataset
    fields:
      id: { type: uuid, posture: allow, pk: true }
      name: { type: text, posture: allow }
  notes:
    description: Test writable collection
    writable: true
    fields:
      id: { type: uuid, posture: allow, pk: true }
      body: { type: text, posture: { read: allow, write: allow } }
  documents:
    type: file
    description: Test files
    source: ./seed/docs-dev
    source_live: ./seed/docs-live
    fields:
      title: { posture: allow }
      content: { posture: allow }
`;
    await writeFile(join(fixture, "warehousd.yml"), yaml);

    // Setup test database
    setup = await setupWebDb("entrypoint-test");

    // Delete the demo personas that setupWebDb creates, so we can test bootstrap creating the admin alone.
    // workspace_members.user_id carries no FK to app.user (see entrypoint.ts's own comment on the
    // same hazard), so the membership rows have to be deleted too — left behind, they orphan onto
    // 'ana'/'marcus'/'mia' and collide with seedDemoPersonas re-keying a fresh signup onto the same
    // slug later in this file.
    const cleanupDb = new Pool({ connectionString: setup.appUrl });
    await cleanupDb.query(
      `delete from app.workspace_members where user_id in ('ana', 'marcus', 'mia')`,
    );
    await cleanupDb.query(`delete from app."user" where id in ('ana', 'marcus', 'mia')`);
    await cleanupDb.end();

    process.env.WAREHOUSD_PROJECT_DIR = fixture;
    process.env.APP_DATABASE_URL = setup.appUrl;
    process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-chars-long-000";
    process.env.BETTER_AUTH_URL ??= "http://localhost:8722";
    process.env.WAREHOUSD_ADMIN_EMAIL = "admin@test.local";
    process.env.WAREHOUSD_ADMIN_PASSWORD = "adminpass123";
    process.env.WAREHOUSD_DATA_ROLE_PASSWORD = "pw";
    process.env.WAREHOUSD_SEED = "42";
    process.env.WAREHOUSD_SKIP_BA_MIGRATE = "true"; // Skip CLI in tests since cwd:/app doesn't exist
    delete process.env.WAREHOUSD_DEMO;
  });

  afterAll(async () => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    if (setup) await setup.end();
  });

  it("bootstrap() on a fresh DB succeeds and creates data", async () => {
    const { bootstrap } = await import("../scripts/entrypoint");
    await bootstrap();

    const db = new Pool({ connectionString: setup.appUrl });

    // Assert data_synth.items has rows (synthetic data generated)
    const itemsResult = await db.query(`select count(*) as cnt from data_synth.items`);
    expect(Number(itemsResult.rows[0].cnt)).toBeGreaterThan(0);

    // Assert data_synth."documents__files" has 2 rows (indexed from seed/docs-dev)
    const filesResult = await db.query(`select count(*) as cnt from data_synth."documents__files"`);
    expect(Number(filesResult.rows[0].cnt)).toBe(2);

    // Assert an admin user exists with role='admin'
    const adminResult = await db.query(`select id, role from app."user" where email = $1`, [
      process.env.WAREHOUSD_ADMIN_EMAIL,
    ]);
    expect(adminResult.rowCount).toBe(1);
    expect(adminResult.rows[0].role).toBe("admin");

    // Assert getDevClient() returns a client whose policy is ["env:dev"]. It returns the id and
    // nothing else — the secret column holds a hash, and handing the plaintext back is what made
    // that column plaintext in the first place.
    const { getDevClient } = await import("@warehousd/broker");
    const client = await getDevClient(db);
    expect(client).not.toBeNull();
    expect(client!.clientId).toBeDefined();
    expect(client).not.toHaveProperty("clientSecret");

    // Assert no demo personas when WAREHOUSD_DEMO is unset
    const usersResult = await db.query(`select id from app."user" order by id`);
    expect(usersResult.rowCount).toBe(1); // Only admin
    expect(usersResult.rows[0].id).not.toMatch(/^(ana|marcus|mia)$/);

    await db.end();
  });

  it("bootstrap() again succeeds and is stable (idempotent)", async () => {
    const { bootstrap } = await import("../scripts/entrypoint");

    // Get state before second bootstrap
    let db = new Pool({ connectionString: setup.appUrl });
    const itemsCountBefore = await db.query(`select count(*) as cnt from data_synth.items`);
    const filesCountBefore = await db.query(
      `select count(*) as cnt from data_synth."documents__files"`,
    );
    const usersCountBefore = await db.query(`select count(*) as cnt from app."user"`);
    const clientBefore = await db.query(
      `select "clientId", "clientSecret" from app."oauthApplication" where name='warehousd dev client'`,
    );
    await db.end();

    // Run bootstrap again
    await bootstrap();

    // Assert counts are the same
    db = new Pool({ connectionString: setup.appUrl });
    const itemsCountAfter = await db.query(`select count(*) as cnt from data_synth.items`);
    const filesCountAfter = await db.query(
      `select count(*) as cnt from data_synth."documents__files"`,
    );
    const usersCountAfter = await db.query(`select count(*) as cnt from app."user"`);
    const clientAfter = await db.query(
      `select "clientId", "clientSecret" from app."oauthApplication" where name='warehousd dev client'`,
    );

    expect(Number(itemsCountAfter.rows[0].cnt)).toBe(Number(itemsCountBefore.rows[0].cnt));
    expect(Number(filesCountAfter.rows[0].cnt)).toBe(Number(filesCountBefore.rows[0].cnt));
    expect(Number(usersCountAfter.rows[0].cnt)).toBe(Number(usersCountBefore.rows[0].cnt));
    expect(clientAfter.rows[0].clientId).toBe(clientBefore.rows[0].clientId);
    expect(clientAfter.rows[0].clientSecret).toBe(clientBefore.rows[0].clientSecret);

    await db.end();
  });

  it("preserves a writable collection's documents and pending proposals across a restart, while a non-writable one is still truncated and regenerated", async () => {
    const { bootstrap } = await import("../scripts/entrypoint");

    // The data-role URLs are populated by bootstrap() itself (entrypoint.ts step 10), and a
    // bootstrap has already run earlier in this file.
    const devUrl = process.env.DEV_DATABASE_URL;
    const devWriteUrl = process.env.DEV_WRITE_DATABASE_URL;
    const liveUrl = process.env.LIVE_DATABASE_URL;
    const liveWriteUrl = process.env.LIVE_WRITE_DATABASE_URL;
    if (!devUrl || !devWriteUrl || !liveUrl || !liveWriteUrl) {
      throw new Error("expected bootstrap() to have set the data-role URLs already");
    }

    const cfg = loadConfig(fixture);
    const pools = createPools({
      app: setup.appUrl,
      dev: devUrl,
      live: liveUrl,
      devWrite: devWriteUrl,
      liveWrite: liveWriteUrl,
    });
    const broker = makeBroker(pools, cfg);
    const app = new Pool({ connectionString: setup.appUrl });

    try {
      // A direct-mode grant writes an approved document; a proposal_only grant parks one as
      // pending. Both go through the broker's real write path — the same one /v1 exposes.
      const writerGrant = await requestGrant(app, {
        userId: "notes_writer",
        collection: "notes",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "body"],
      });
      await approveGrant(app, cfg, writerGrant, "admin", {
        verbs: ["read", "create"],
        mode: "direct",
      });

      const proposerGrant = await requestGrant(app, {
        userId: "notes_proposer",
        collection: "notes",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "body"],
      });
      await approveGrant(app, cfg, proposerGrant, "admin", {
        verbs: ["read", "create"],
        mode: "proposal_only",
      });

      const writeResult = await broker.mutate(makeCtx({ userId: "notes_writer" }), {
        collection: "notes",
        op: "create",
        values: { body: "written by a client, over the write path" },
      });
      assertApplied(writeResult);
      const writtenId = writeResult.documentId;

      const proposeResult = await broker.mutate(makeCtx({ userId: "notes_proposer" }), {
        collection: "notes",
        op: "create",
        values: { body: "proposed, not yet decided" },
      });
      assertPending(proposeResult);
      const proposalId = proposeResult.proposalId;

      // A canary row in the non-writable collection, inserted the way generateSynthetic never
      // would. If the truncate-then-generate loop still runs unconditionally for `items`, this
      // row cannot survive a restart no matter what the generator produces afterward.
      const canaryId = randomUUID();
      await app.query(
        `insert into data_synth.items (${SEED_REV_COLUMNS}, id, name) values (${SEED_REV_VALUES}, $1, 'CANARY-NON-WRITABLE')`,
        [canaryId],
      );

      await bootstrap();

      const writtenAfter = await app.query(`select id, body from data_synth.notes where id = $1`, [
        writtenId,
      ]);
      expect(writtenAfter.rowCount).toBe(1);
      expect(writtenAfter.rows[0].body).toBe("written by a client, over the write path");

      const proposalAfter = await app.query(
        `select _rev_status from data_synth.notes where _rev = $1`,
        [proposalId],
      );
      expect(proposalAfter.rowCount).toBe(1);
      expect(proposalAfter.rows[0]._rev_status).toBe("pending");

      const canaryAfter = await app.query(`select 1 from data_synth.items where id = $1`, [
        canaryId,
      ]);
      expect(canaryAfter.rowCount).toBe(0);

      const itemsAfter = await app.query(`select count(*) as cnt from data_synth.items`);
      expect(Number(itemsAfter.rows[0].cnt)).toBeGreaterThan(0);
    } finally {
      await app.end();
      await pools.end();
    }
  });

  it("bootstrap() picks up new collections added to YAML", async () => {
    const { bootstrap } = await import("../scripts/entrypoint");

    // Add a new collection to the fixture YAML
    const yaml = `
project: test-entrypoint
server: { port: 8722 }
taxonomies:
  category:
    label: Category
    terms:
      general: { label: General }
collections:
  items:
    description: Test dataset
    fields:
      id: { type: uuid, posture: allow, pk: true }
      name: { type: text, posture: allow }
  notes:
    description: Test writable collection
    writable: true
    fields:
      id: { type: uuid, posture: allow, pk: true }
      body: { type: text, posture: { read: allow, write: allow } }
  documents:
    type: file
    description: Test files
    source: ./seed/docs-dev
    source_live: ./seed/docs-live
    fields:
      title: { posture: allow }
      content: { posture: allow }
  newcollection:
    description: New test collection
    fields:
      id: { type: uuid, posture: allow, pk: true }
      value: { type: text, posture: allow }
`;
    await writeFile(join(fixture, "warehousd.yml"), yaml);

    // Run bootstrap again
    await bootstrap();

    // Assert the new collection has rows
    const db = new Pool({ connectionString: setup.appUrl });
    const newCollectionResult = await db.query(
      `select count(*) as cnt from data_synth.newcollection`,
    );
    expect(Number(newCollectionResult.rows[0].cnt)).toBeGreaterThan(0);

    await db.end();
  });

  it("with WAREHOUSD_DEMO=true, demo personas are created", async () => {
    const { bootstrap } = await import("../scripts/entrypoint");

    // Delete existing demo personas to start fresh
    let db = new Pool({ connectionString: setup.appUrl });
    await db.query(`delete from app.grants where user_id in ('ana', 'marcus', 'mia')`);
    await db.query(`delete from app."user" where id in ('ana', 'marcus', 'mia')`);
    await db.end();

    // Set WAREHOUSD_DEMO and call bootstrap again
    process.env.WAREHOUSD_DEMO = "true";
    await bootstrap();

    // Assert demo personas exist (ana, marcus, mia, plus the extra personas behind
    // LoginForm's "more personas" disclosure)
    db = new Pool({ connectionString: setup.appUrl });
    const usersResult = await db.query(`select id from app."user" order by id`);
    const ids = usersResult.rows.map((r: any) => r.id);

    // Should have admin + 7 demo personas
    expect(usersResult.rowCount).toBe(8);
    expect(ids).toContain("ana");
    expect(ids).toContain("marcus");
    expect(ids).toContain("mia");
    expect(ids).toContain("lanna");
    expect(ids).toContain("dan");
    expect(ids).toContain("elena");
    expect(ids).toContain("omar");

    // Verify roles
    const anaRole = await db.query(`select role from app."user" where id='ana'`);
    const marcusRole = await db.query(`select role from app."user" where id='marcus'`);
    const miaRole = await db.query(`select role from app."user" where id='mia'`);
    const lannaRole = await db.query(`select role from app."user" where id='lanna'`);
    const danRole = await db.query(`select role from app."user" where id='dan'`);

    expect(anaRole.rows[0].role).toBe("admin");
    expect(marcusRole.rows[0].role).toBe("manager");
    expect(miaRole.rows[0].role).toBe("member");
    expect(lannaRole.rows[0].role).toBe("manager");
    expect(danRole.rows[0].role).toBe("member");

    // Verify grants are created (at least for ana and marcus)
    const grantCount = await db.query(`select count(*) as cnt from app.grants`);
    expect(Number(grantCount.rows[0].cnt)).toBeGreaterThan(0);

    // Assert data_live table for file collections is populated when the live source is present
    const documentsLiveResult = await db.query(
      `select count(*) as cnt from data_live."documents__files"`,
    );
    expect(Number(documentsLiveResult.rows[0].cnt)).toBeGreaterThan(0);

    await db.end();
  });

  // `warehousd deploy` bundles the project into the image but omits every `source_live` directory,
  // so a deployed instance boots with source_live declared and absent. indexCollection walks the
  // directory with readdirSync, which throws ENOENT rather than returning nothing — so without the
  // guard in the entrypoint this exact shape kills the Fly release command and aborts the deploy.
  it("skips live indexing when source_live is declared but absent, and still boots", async () => {
    rmSync(join(fixture, "seed", "docs-live"), { recursive: true, force: true });

    const { bootstrap } = await import("../scripts/entrypoint");
    await expect(bootstrap()).resolves.not.toThrow();

    const db = new Pool({ connectionString: setup.appUrl });
    // Dev content is still indexed — the app comes up fully usable.
    const dev = await db.query(`select count(*) as cnt from data_synth."documents__files"`);
    expect(Number(dev.rows[0].cnt)).toBe(2);
    await db.end();
  });
});
