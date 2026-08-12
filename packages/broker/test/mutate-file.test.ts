import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { assertApplied } from "./helpers/results";

let p: Provisioned, app: Pool, pools: any;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  taxonomies: {
    category: {
      label: "Categories",
      terms: {
        engineering: { label: "Engineering" },
        design: { label: "Design" },
      },
    },
  },
  collections: {
    docs: {
      type: "file",
      description: "Documentation",
      source: "./docs",
      writable: true,
      taxonomies: ["category"],
      fields: {
        title: { posture: { read: "allow", write: "allow" } },
        content: { posture: { read: "allow", write: "allow" } },
        path: { posture: "deny" },
        owner: { posture: { read: "allow", write: "allow" } },
        updated_at: { posture: { read: "allow", write: "allow" } },
        category: { posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("mutate-file");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({
    app: p.urls.admin,
    dev: p.urls.dev,
    live: p.urls.live,
    devWrite: p.urls.devWrite,
    liveWrite: p.urls.liveWrite,
  });
  broker = makeBroker(pools, cfg);
}, 60_000);

afterAll(async () => {
  await app.end();
  await pools.end();
  await p.end();
});

describe("broker.mutate file operations", () => {
  it("create inserts file row plus chunks, searchable via searchDocuments", async () => {
    const grantId = await requestGrant(app, {
      userId: "file_user",
      collection: "docs",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["title", "content", "owner", "updated_at", "category"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = makeCtx({ userId: "file_user" });
    const now = new Date().toISOString();
    const result = await broker.mutate(ctx, {
      collection: "docs",
      op: "create",
      values: {
        path: "test.md",
        title: "Test Doc",
        content: "This is test content\n\nWith multiple paragraphs",
        owner: "file_user",
        updated_at: now,
        category: "engineering",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      assertApplied(result);
      expect(result.status).toBe("applied");
      expect(result.rev).toMatch(/^[0-9a-f]{64}$/); // no revisions on a file; rev is the content checksum

      // Verify file exists
      const fileRow = await app.query(
        `select title, owner, category from data_synth."docs__files" where id = $1`,
        [result.documentId],
      );
      expect(fileRow.rows[0].title).toBe("Test Doc");
      expect(fileRow.rows[0].category).toBe("engineering");

      // Verify chunks exist
      const chunks = await app.query(
        `select content from data_synth."docs__documents" where file_id = $1 order by document_seq`,
        [result.documentId],
      );
      expect(chunks.rowCount).toBeGreaterThan(0);
      expect(chunks.rows[0].content).toContain("This is test content");

      // Verify searchable via searchDocuments
      const searchResult = await broker.searchDocuments(ctx, {
        collection: "docs",
        q: "test content",
      });
      expect(searchResult.ok).toBe(true);
      if (searchResult.ok) {
        const found = searchResult.documents.find((d) => d.title === "Test Doc");
        expect(found).toBeDefined();
      }
    }
  });

  it("duplicate path returns conflict", async () => {
    const grantId = await requestGrant(app, {
      userId: "dup_user",
      collection: "docs",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["title", "content", "owner", "updated_at"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = makeCtx({ userId: "dup_user" });
    const now = new Date().toISOString();
    const path = "duplicate.md";

    // First create
    const result1 = await broker.mutate(ctx, {
      collection: "docs",
      op: "create",
      values: {
        path,
        title: "First",
        content: "First content",
        owner: "dup_user",
        updated_at: now,
      },
    });
    expect(result1.ok).toBe(true);

    // Second create with same path
    const result2 = await broker.mutate(ctx, {
      collection: "docs",
      op: "create",
      values: {
        path,
        title: "Second",
        content: "Second content",
        owner: "dup_user",
        updated_at: now,
      },
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toBe("conflict");
  });

  it("update on file collection returns verb_not_supported", async () => {
    const grantId = await requestGrant(app, {
      userId: "update_file_user",
      collection: "docs",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["title", "content"],
    });
    // Even with update verb granted, file collections don't support it
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "update"] });

    // Create a file first
    const fileId = (
      await app.query(
        `insert into data_synth."docs__files" (id, workspace_id, path, title, owner, checksum, updated_at)
       values (gen_random_uuid(), 'default', 'seeded-for-update.md', 'Test', 'admin', 'abc', now()) returning id`,
      )
    ).rows[0].id;

    const ctx: BrokerContext = makeCtx({ userId: "update_file_user" });
    const result = await broker.mutate(ctx, {
      collection: "docs",
      op: "update",
      id: fileId,
      values: { title: "Updated" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("verb_not_supported");
  });

  it("delete on file collection returns verb_not_supported", async () => {
    const grantId = await requestGrant(app, {
      userId: "delete_file_user",
      collection: "docs",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["title", "content"],
    });
    // Even with delete verb granted, file collections don't support it
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "delete"] });

    // Create a file first
    const fileId = (
      await app.query(
        `insert into data_synth."docs__files" (id, workspace_id, path, title, owner, checksum, updated_at)
       values (gen_random_uuid(), 'default', 'seeded-for-delete.md', 'Test', 'admin', 'abc', now()) returning id`,
      )
    ).rows[0].id;

    const ctx: BrokerContext = makeCtx({ userId: "delete_file_user" });
    const result = await broker.mutate(ctx, {
      collection: "docs",
      op: "delete",
      id: fileId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("verb_not_supported");
  });

  it("unknown taxonomy term returns invalid_value", async () => {
    const grantId = await requestGrant(app, {
      userId: "term_user",
      collection: "docs",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["title", "content", "owner", "updated_at", "category"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = makeCtx({ userId: "term_user" });
    const result = await broker.mutate(ctx, {
      collection: "docs",
      op: "create",
      values: {
        path: "bad-term.md",
        title: "Bad Term",
        content: "content",
        owner: "term_user",
        updated_at: new Date().toISOString(),
        category: "unknown-term",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_value");
  });
});
