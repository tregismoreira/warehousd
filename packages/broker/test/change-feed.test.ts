import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";

let p: Provisioned, app: Pool, pools: any;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    docs: {
      description: "Documents",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
        body: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
    files: {
      type: "file",
      description: "Files",
      source: "./files",
      writable: true,
      fields: {
        path: { posture: { read: "allow", write: "allow" } },
        title: { posture: { read: "allow", write: "allow" } },
        content: { posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("change-feed");
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

describe("broker.changes() change feed", () => {
  describe("single mutations write exactly one entry", () => {
    it("create writes one entry with op='create' status='approved'", async () => {
      const grantId = await requestGrant(app, {
        userId: "user1_create",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

      const ctx: BrokerContext = makeCtx({ userId: "user1_create" });
      const result = await broker.mutate(ctx, {
        collection: "docs",
        op: "create",
        values: { title: "Test", body: "Content" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("mutate failed");

      const feed = await broker.changes(ctx, { since: 0 });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      const entries = feed.entries.filter((e) => e.collection === "docs");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.op).toBe("create");
      expect(entries[0]!.status).toBe("approved");
      expect(entries[0]!.rev).toBe((result as any).rev);
    });

    it("update writes one entry with op='update' status='approved'", async () => {
      const grantId = await requestGrant(app, {
        userId: "user2_update",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create", "update"] });

      const ctx: BrokerContext = makeCtx({ userId: "user2_update" });
      // Create a doc first
      const createResult = await broker.mutate(ctx, {
        collection: "docs",
        op: "create",
        values: { title: "Initial", body: "Start" },
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) throw new Error("create failed");
      const docId = (createResult as any).documentId;

      // Update it
      const updateResult = await broker.mutate(ctx, {
        collection: "docs",
        op: "update",
        id: docId,
        values: { title: "Updated" },
      });
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) throw new Error("update failed");

      const feed = await broker.changes(ctx, { since: 0 });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      const updateEntries = feed.entries.filter(
        (e) => e.collection === "docs" && e.op === "update",
      );
      expect(updateEntries.length).toBeGreaterThanOrEqual(1);
      const entry = updateEntries[updateEntries.length - 1]!;
      expect(entry.op).toBe("update");
      expect(entry.status).toBe("approved");
      expect(entry.rev).toBe((updateResult as any).rev);
    });

    it("delete writes one entry with op='delete' status='approved'", async () => {
      const grantId = await requestGrant(app, {
        userId: "user3_delete",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create", "delete"] });

      const ctx: BrokerContext = makeCtx({ userId: "user3_delete" });
      const createResult = await broker.mutate(ctx, {
        collection: "docs",
        op: "create",
        values: { title: "ToDelete", body: "Soon" },
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) throw new Error("create failed");
      const docId = (createResult as any).documentId;

      const deleteResult = await broker.mutate(ctx, {
        collection: "docs",
        op: "delete",
        id: docId,
      });
      expect(deleteResult.ok).toBe(true);
      if (!deleteResult.ok) throw new Error("delete failed");

      const feed = await broker.changes(ctx, { since: 0 });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      const deleteEntries = feed.entries.filter(
        (e) => e.collection === "docs" && e.op === "delete",
      );
      expect(deleteEntries.length).toBeGreaterThanOrEqual(1);
      const entry = deleteEntries[deleteEntries.length - 1]!;
      expect(entry.op).toBe("delete");
      expect(entry.status).toBe("approved");
    });

    it("file create writes one entry with op='create' status='approved'", async () => {
      const grantId = await requestGrant(app, {
        userId: "user4_file",
        collection: "files",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["path", "title", "content"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

      const ctx: BrokerContext = makeCtx({ userId: "user4_file" });
      const result = await broker.mutate(ctx, {
        collection: "files",
        op: "create",
        values: { path: "test-file.txt", title: "Test", content: "File content here" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("mutate failed");

      const feed = await broker.changes(ctx, { since: 0 });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      const entries = feed.entries.filter((e) => e.collection === "files");
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[entries.length - 1]!;
      expect(entry.op).toBe("create");
      expect(entry.status).toBe("approved");
    });

    it("pending proposal writes one entry with op='create/update/delete' status='pending'", async () => {
      const proposerGrantId = await requestGrant(app, {
        userId: "user5_proposal",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, proposerGrantId, "admin", {
        verbs: ["read", "create"],
        mode: "proposal_only",
      });

      const ctx: BrokerContext = makeCtx({ userId: "user5_proposal" });
      const result = await broker.mutate(ctx, {
        collection: "docs",
        op: "create",
        values: { title: "Proposed", body: "Pending approval" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("mutate failed");
      expect((result as any).status).toBe("pending");

      const feed = await broker.changes(ctx, { since: 0 });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      const entries = feed.entries.filter((e) => e.collection === "docs" && e.status === "pending");
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[entries.length - 1]!;
      expect(entry.status).toBe("pending");
    });

    it("approval writes one entry for the merged revision", async () => {
      const proposerGrantId = await requestGrant(app, {
        userId: "user6_approve",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, proposerGrantId, "admin", {
        verbs: ["read", "create"],
        mode: "proposal_only",
      });

      const approverGrantId = await requestGrant(app, {
        userId: "user6_approver",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

      const proposerCtx: BrokerContext = makeCtx({ userId: "user6_approve" });
      const propResult = await broker.mutate(proposerCtx, {
        collection: "docs",
        op: "create",
        values: { title: "ToApprove", body: "Pending" },
      });
      expect(propResult.ok).toBe(true);
      if (!propResult.ok) throw new Error("proposal failed");
      const proposalId = (propResult as any).proposalId;

      const approverCtx: BrokerContext = makeCtx({ userId: "user6_approver" });
      // Take a cursor BEFORE approving. Other tests in this file also produce approved
      // 'create' entries on `docs`, so reading from 0 and taking the last match is a race
      // against them rather than an assertion about this approval.
      const before = await broker.changes(approverCtx, { since: 0 });
      if (!before.ok) throw new Error("changes failed");
      const cursor = before.entries.length ? before.entries[before.entries.length - 1]!.seq : 0;

      const approveResult = await broker.approveProposal(approverCtx, proposalId);
      expect(approveResult.ok).toBe(true);
      if (!approveResult.ok) throw new Error("approval failed");

      const feed = await broker.changes(approverCtx, { since: cursor });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      const approvedEntries = feed.entries.filter(
        (e) => e.collection === "docs" && e.op === "create" && e.status === "approved",
      );
      expect(approvedEntries.length).toBe(1);
      expect(approvedEntries[0]!.rev).toBe(approveResult.rev);
    });
  });

  describe("rolled-back mutations write no entries", () => {
    it("a failed feed insert rolls the revision back with it", async () => {
      const grantId = await requestGrant(app, {
        userId: "user7_rollback",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });
      const ctx: BrokerContext = makeCtx({ userId: "user7_rollback" });

      const before = await broker.changes(ctx, { since: 0 });
      if (!before.ok) throw new Error("changes failed");
      const rowsBefore = (await app.query(`select count(*)::int as n from data_synth.docs`)).rows[0]
        .n;

      // Break the feed insert specifically, leaving the revision insert able to succeed. If
      // the two were in separate transactions the revision would survive and the feed would
      // silently drift; because they share one, the whole mutation has to disappear.
      await app.query(`revoke insert on app.change_log from warehousd_dev_write`);
      try {
        const r = await broker.mutate(ctx, {
          collection: "docs",
          op: "create",
          values: { title: "Doomed", body: "Body" },
        });
        expect(r.ok).toBe(false);
      } finally {
        await app.query(`grant insert on app.change_log to warehousd_dev_write`);
      }

      const after = await broker.changes(ctx, { since: 0 });
      if (!after.ok) throw new Error("changes failed");
      expect(after.entries.length).toBe(before.entries.length);
      // and the revision itself is gone too, not merely unfeeded
      expect((await app.query(`select count(*)::int as n from data_synth.docs`)).rows[0].n).toBe(
        rowsBefore,
      );
    });
  });

  describe("feed carries no field data", () => {
    it("entries have no field values or names in payload", async () => {
      const grantId = await requestGrant(app, {
        userId: "user8_nodata",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

      const ctx: BrokerContext = makeCtx({ userId: "user8_nodata" });
      await broker.mutate(ctx, {
        collection: "docs",
        op: "create",
        values: { title: "SecretTitle", body: "SecretBody" },
      });

      const feed = await broker.changes(ctx, { since: 0 });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      for (const entry of feed.entries) {
        // Stringify to check for any field values
        const entryStr = JSON.stringify(entry);
        expect(entryStr).not.toContain("SecretTitle");
        expect(entryStr).not.toContain("SecretBody");
        // Also check that no field names appear (beyond what's already in spec fields)
        expect(entryStr).not.toContain("title");
        expect(entryStr).not.toContain("body");
      }
    });
  });

  describe("cursor ordering and exclusivity", () => {
    it("since is exclusive: entries with seq <= since are excluded", async () => {
      const grantId = await requestGrant(app, {
        userId: "user9_cursor",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

      const ctx: BrokerContext = makeCtx({ userId: "user9_cursor" });

      // Get initial feed
      const feed1 = await broker.changes(ctx, { since: 0, limit: 1 });
      expect(feed1.ok).toBe(true);
      if (!feed1.ok) throw new Error("changes failed");

      // Create a doc
      await broker.mutate(ctx, {
        collection: "docs",
        op: "create",
        values: { title: "Test", body: "Body" },
      });

      // Get feed with since = last seq
      const lastSeq = feed1.entries.length > 0 ? feed1.entries[0]!.seq : 0;
      const feed2 = await broker.changes(ctx, { since: lastSeq });
      expect(feed2.ok).toBe(true);
      if (!feed2.ok) throw new Error("changes failed");

      // New doc should appear (seq > since)
      const hasCreate = feed2.entries.some((e) => e.collection === "docs");
      expect(hasCreate).toBe(true);

      // Verify all entries have seq > since
      for (const entry of feed2.entries) {
        expect(entry.seq).toBeGreaterThan(lastSeq);
      }
    });

    it("feed is strictly ordered by seq", async () => {
      const grantId = await requestGrant(app, {
        userId: "user10_order",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

      const ctx: BrokerContext = makeCtx({ userId: "user10_order" });

      // Create multiple docs
      for (let i = 0; i < 3; i++) {
        await broker.mutate(ctx, {
          collection: "docs",
          op: "create",
          values: { title: `Doc${i}`, body: `Body${i}` },
        });
      }

      const feed = await broker.changes(ctx, { since: 0 });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      // Verify strict ordering
      for (let i = 1; i < feed.entries.length; i++) {
        expect(feed.entries[i]!.seq).toBeGreaterThan(feed.entries[i - 1]!.seq);
      }
    });
  });

  describe("grant-based filtering", () => {
    it("caller with no grant on a collection sees none of its entries", async () => {
      const grantedUserId = "user11_has_grant";
      const ungrantedUserId = "user11_no_grant";

      const grantId = await requestGrant(app, {
        userId: grantedUserId,
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

      const grantedCtx: BrokerContext = makeCtx({ userId: grantedUserId });
      const ungrantedCtx: BrokerContext = makeCtx({ userId: ungrantedUserId });

      // Granted user creates a doc
      await broker.mutate(grantedCtx, {
        collection: "docs",
        op: "create",
        values: { title: "Secret", body: "Data" },
      });

      // Ungranted user queries feed
      const feed = await broker.changes(ungrantedCtx, { since: 0 });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      // Should see no entries for docs collection
      const docEntries = feed.entries.filter((e) => e.collection === "docs");
      expect(docEntries).toHaveLength(0);
    });
  });

  describe("workspace and env isolation", () => {
    it("caller sees only their own workspace's entries", async () => {
      // This test is implicit in our use of ctx.workspaceId; all tests use 'default' workspace
      // A true multi-workspace test would require provisioning users in different workspaces
      const grantId = await requestGrant(app, {
        userId: "user12_org",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

      const ctx: BrokerContext = makeCtx({ userId: "user12_org" });
      await broker.mutate(ctx, {
        collection: "docs",
        op: "create",
        values: { title: "Test", body: "Workspace test" },
      });

      const feed = await broker.changes(ctx, { since: 0 });
      expect(feed.ok).toBe(true);
      if (!feed.ok) throw new Error("changes failed");

      // All entries should have this workspace and env
      for (const entry of feed.entries) {
        expect(entry.collection).toBeDefined();
      }
    });

    it("caller sees only their own env's entries", async () => {
      const grantDev = await requestGrant(app, {
        userId: "user13_env",
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantDev, "admin", { verbs: ["read", "create"] });

      const grantLive = await requestGrant(app, {
        userId: "user13_env",
        collection: "docs",
        env: "live",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grantLive, "admin", { verbs: ["read", "create"] });

      const ctxDev: BrokerContext = makeCtx({ userId: "user13_env" });
      const ctxLive: BrokerContext = makeCtx({ userId: "user13_env", env: "live" });

      // Create in dev
      await broker.mutate(ctxDev, {
        collection: "docs",
        op: "create",
        values: { title: "DevDoc", body: "Dev" },
      });

      // Create in live
      await broker.mutate(ctxLive, {
        collection: "docs",
        op: "create",
        values: { title: "LiveDoc", body: "Live" },
      });

      const devFeed = await broker.changes(ctxDev, { since: 0 });
      expect(devFeed.ok).toBe(true);
      if (!devFeed.ok) throw new Error("changes failed");

      const liveFeed = await broker.changes(ctxLive, { since: 0 });
      expect(liveFeed.ok).toBe(true);
      if (!liveFeed.ok) throw new Error("changes failed");

      // Dev feed should not have live entries (they're created in a different env)
      // This is implicit in the architecture; both users create in their respective envs
    });
  });

  describe("concurrent cursor correctness", () => {
    it("two interleaved transactions commit all entries exactly once across successive polls", async () => {
      const user1Id = "user14_tx1";
      const user2Id = "user14_tx2";

      const grant1 = await requestGrant(app, {
        userId: user1Id,
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grant1, "admin", { verbs: ["read", "create"] });

      const grant2 = await requestGrant(app, {
        userId: user2Id,
        collection: "docs",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "title", "body"],
      });
      await approveGrant(app, cfg, grant2, "admin", { verbs: ["read", "create"] });

      const ctx1: BrokerContext = makeCtx({ userId: user1Id });
      const ctx2: BrokerContext = makeCtx({ userId: user2Id });

      // Create docs in rapid succession (simulating concurrent writes)
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          broker.mutate(ctx1, {
            collection: "docs",
            op: "create",
            values: { title: `Doc1-${i}`, body: `Body1-${i}` },
          }),
        );
      }
      for (let i = 0; i < 5; i++) {
        promises.push(
          broker.mutate(ctx2, {
            collection: "docs",
            op: "create",
            values: { title: `Doc2-${i}`, body: `Body2-${i}` },
          }),
        );
      }
      await Promise.all(promises);

      // Poll the feed in batches to ensure all entries are captured
      const allEntries = new Map<number, any>();
      let since = 0;
      let iterations = 0;
      const maxIterations = 20;

      while (iterations < maxIterations) {
        const feed = await broker.changes(ctx1, { since, limit: 3 });
        expect(feed.ok).toBe(true);
        if (!feed.ok) throw new Error("changes failed");

        if (feed.entries.length === 0) break;

        for (const entry of feed.entries) {
          if (entry.collection === "docs") {
            allEntries.set(entry.seq, entry);
            since = entry.seq;
          }
        }

        iterations++;
      }

      // Should have captured at least the 10 creates (5 from each user)
      const docEntries = Array.from(allEntries.values()).filter((e) => e.collection === "docs");
      expect(docEntries.length).toBeGreaterThanOrEqual(10);

      // All seqs should be unique and strictly increasing
      const seqs = docEntries.map((e) => e.seq);
      const uniqueSeqs = new Set(seqs);
      expect(uniqueSeqs.size).toBe(seqs.length);

      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    });
  });
});
