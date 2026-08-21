import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker, type Pools } from "../src/index";
import { importCollection } from "../src/import/run";
import { ConfigSchema } from "../src/config/schema";
import { requestGrant, approveGrant } from "../src/grants/manage";
import { makeCtx } from "./helpers/ctx";
import { assertApplied, assertPending } from "./helpers/results";

// PR 1: a `type: json` field must survive a partial update — the write that carries it forward
// unchanged binds it as a Postgres array literal today, and the column refuses it. See
// packages/broker/src/db/encode.ts for the fix and the reasoning behind it.

const cfg = ConfigSchema.parse({
  project: "json-carry-forward",
  server: { port: 1 },
  collections: {
    pages: {
      description: "d",
      writable: true,
      fields: {
        id: { type: "uuid", posture: { read: "allow", write: "allow" }, pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
        tags: { type: "json", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("jsoncarry");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({
    app: p.urls.admin,
    dev: p.urls.dev,
    live: p.urls.live,
    imp: p.urls.imp,
    devWrite: p.urls.devWrite,
    liveWrite: p.urls.liveWrite,
  });
  broker = makeBroker(pools, cfg);

  const grantId = await requestGrant(admin, {
    userId: "writer",
    collection: "pages",
    env: "dev",
    workspaceId: "default",
    purposeLabel: "test",
    allowedFields: ["id", "title", "tags"],
  });
  await approveGrant(admin, cfg, grantId, "admin", { verbs: ["read", "create", "update"] });
}, 60_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

const ctx = () => makeCtx({ userId: "writer" });

describe("a json field carries forward through a partial update", () => {
  it("carries a json array forward when an unrelated field is updated", async () => {
    const created = await broker.mutate(ctx(), {
      collection: "pages",
      op: "create",
      values: { title: "repro", tags: ["a", "b"] }, // a top-level ARRAY — an object does not reproduce
    });
    assertApplied(created);

    const updated = await broker.mutate(ctx(), {
      collection: "pages",
      op: "update",
      id: created.documentId,
      values: { title: "repro2" }, // tags is NOT in the payload
    });
    assertApplied(updated);

    const row = await admin.query(
      `select title, tags from data_synth.pages where id = $1 and _current`,
      [created.documentId],
    );
    expect(row.rows[0].title).toBe("repro2");
    expect(row.rows[0].tags).toEqual(["a", "b"]); // the json value round-trips unchanged
  });

  it("carries a json object forward when an unrelated field is updated", async () => {
    const created = await broker.mutate(ctx(), {
      collection: "pages",
      op: "create",
      values: { title: "repro-obj", tags: { a: 1 } },
    });
    assertApplied(created);

    const updated = await broker.mutate(ctx(), {
      collection: "pages",
      op: "update",
      id: created.documentId,
      values: { title: "repro-obj2" },
    });
    assertApplied(updated);

    const row = await admin.query(
      `select title, tags from data_synth.pages where id = $1 and _current`,
      [created.documentId],
    );
    expect(row.rows[0].title).toBe("repro-obj2");
    expect(row.rows[0].tags).toEqual({ a: 1 });
  });

  it("carries a bare json string forward without double-encoding it", async () => {
    const created = await broker.mutate(ctx(), {
      collection: "pages",
      op: "create",
      // A json field's scalar value is submitted as JSON text — `coerce` validates it by parsing,
      // same as a CSV cell would be — so a JSON *string* value is quoted: '"draft"' means the
      // document `"draft"`, not the four-letter word.
      values: { title: "repro-str", tags: '"draft"' },
    });
    assertApplied(created);

    const updated = await broker.mutate(ctx(), {
      collection: "pages",
      op: "update",
      id: created.documentId,
      values: { title: "repro-str2" },
    });
    assertApplied(updated);

    const row = await admin.query(
      `select title, tags from data_synth.pages where id = $1 and _current`,
      [created.documentId],
    );
    expect(row.rows[0].title).toBe("repro-str2");
    // The JSON string "draft" — not the bare word `draft`, and not the double-encoded `"draft"`.
    expect(row.rows[0].tags).toBe("draft");
  });

  it("leaves a json field left NULL as SQL NULL, never the jsonb document null", async () => {
    const created = await broker.mutate(ctx(), {
      collection: "pages",
      op: "create",
      values: { title: "no-tags" }, // tags never stated
    });
    assertApplied(created);

    const row = await admin.query(
      `select title from data_synth.pages where id = $1 and _current and tags is null`,
      [created.documentId],
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].title).toBe("no-tags");
  });

  it("carries a json array forward through propose -> approve (mergeRevision)", async () => {
    const proposerId = "json_proposer";
    const approverId = "json_approver";

    const proposerGrantId = await requestGrant(admin, {
      userId: proposerId,
      collection: "pages",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "title", "tags"],
    });
    await approveGrant(admin, cfg, proposerGrantId, "admin", {
      verbs: ["read", "create", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(admin, {
      userId: approverId,
      collection: "pages",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "title", "tags"],
    });
    await approveGrant(admin, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    const proposerCtx = makeCtx({ userId: proposerId });
    const approverCtx = makeCtx({ userId: approverId });

    const created = await broker.mutate(proposerCtx, {
      collection: "pages",
      op: "create",
      values: { title: "prop-repro", tags: ["a", "b"] },
    });
    assertPending(created);
    const createApprove = await broker.approveProposal(approverCtx, created.proposalId);
    expect(createApprove.ok, JSON.stringify(createApprove)).toBe(true);
    if (!createApprove.ok) return;
    const documentId = createApprove.documentId;

    const updated = await broker.mutate(proposerCtx, {
      collection: "pages",
      op: "update",
      id: documentId,
      values: { title: "prop-repro2" },
    });
    assertPending(updated);
    const updateApprove = await broker.approveProposal(approverCtx, updated.proposalId);
    expect(updateApprove.ok, JSON.stringify(updateApprove)).toBe(true);

    const row = await admin.query(
      `select title, tags from data_synth.pages where id = $1 and _current`,
      [documentId],
    );
    expect(row.rows[0].title).toBe("prop-repro2");
    expect(row.rows[0].tags).toEqual(["a", "b"]);
  });

  it("carries a json array forward through importCollection upsert mode", async () => {
    const id = randomUUID();
    const created = await importCollection(pools, cfg, "importer", "pages", {
      format: "json",
      text: JSON.stringify([{ id, title: "import-repro", tags: ["a", "b"] }]),
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);

    const updated = await importCollection(
      pools,
      cfg,
      "importer",
      "pages",
      { format: "json", text: JSON.stringify([{ id, title: "import-repro2" }]) },
      { mode: "upsert" },
    );
    expect(updated.ok, JSON.stringify(updated)).toBe(true);

    const row = await admin.query(
      `select title, tags from data_live.pages where id = $1 and _current`,
      [id],
    );
    expect(row.rows[0].title).toBe("import-repro2");
    expect(row.rows[0].tags).toEqual(["a", "b"]);
  });
});
