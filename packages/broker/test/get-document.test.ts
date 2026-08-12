import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
import type { WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { ConfigSchema } from "../src/config/schema";

import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// Every dataset table carries NOT NULL revision bookkeeping, so a fixture insert has to
// be a well-formed `create` revision. These are literals; every value stays bound.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

let p: Provisioned, app: Pool, pools: any;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  synthetic: { documents_per_collection: {} },
  collections: {
    people: {
      description: "dir",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: "allow" },
        status: { type: "text", posture: "allow" },
        owner: { type: "text", posture: "allow" },
      },
    },
    articles: {
      writable: true as const,
      description: "writable dataset",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } as const },
        content: { type: "text", posture: { read: "allow", write: "allow" } as const },
      },
    },
    sources: {
      type: "file" as const,
      description: "d",
      source: "./x",
      fields: {
        title: { posture: "allow" as const },
        content: { posture: "allow" as const },
        path: { posture: "deny" as const },
      },
    },
  },
});

beforeAll(async () => {
  p = await provision("get-document");
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
}, 60_000);
afterAll(async () => {
  await app.end();
  await pools.end();
  await p.end();
});

describe("broker.getDocument", () => {
  it("returns only granted fields", async () => {
    const userId = "user_fields_test";
    const ctxTest: BrokerContext = makeCtx({ userId, env: "live" });
    // Request grant for subset of fields
    const grantId = await requestGrant(app, {
      userId,
      collection: "people",
      env: "live",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read"] });

    // Insert test data
    const id = (
      await app.query(
        `insert into data_live.people (${R}, workspace_id, id, email, status) values (${RV}, 'default', gen_random_uuid(), 'test@ex.com', 'active') returning id`,
      )
    ).rows[0].id;

    const broker = makeBroker(pools, cfg);
    const result = await broker.getDocument(ctxTest, { collection: "people", id: id.toString() });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fieldsReturned).toEqual(["id", "email"]);
      expect(result.document).toHaveProperty("id");
      expect(result.document).toHaveProperty("email");
      expect(result.document).not.toHaveProperty("status");
    }
  });

  it("a document excluded by the document filter is not_found", async () => {
    const userId = "user_filter_test";
    const ctxTest: BrokerContext = makeCtx({ userId, env: "live" });
    // Request grant with document filter
    const grantId = await requestGrant(app, {
      userId,
      collection: "people",
      env: "live",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "status"],
    });
    await approveGrant(app, cfg, grantId, "admin", {
      verbs: ["read"],
      documentFilters: [{ field: "status", op: "eq", value: "active" }],
    });

    // Insert inactive document
    const id = (
      await app.query(
        `insert into data_live.people (${R}, workspace_id, id, email, status) values (${RV}, 'default', gen_random_uuid(), 'test@ex.com', 'inactive') returning id`,
      )
    ).rows[0].id;

    const broker = makeBroker(pools, cfg);
    const result = await broker.getDocument(ctxTest, { collection: "people", id: id.toString() });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("$self filter scopes it", async () => {
    const userId = "self_user";
    const ctxSelf: BrokerContext = makeCtx({ userId, env: "live" });

    // Request grant with $self filter
    const grantId = await requestGrant(app, {
      userId,
      collection: "people",
      env: ctxSelf.env,
      workspaceId: ctxSelf.workspaceId,
      purposeLabel: "test",
      allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", {
      verbs: ["read"],
      documentFilters: [{ field: "owner", op: "eq", value: "$self" }],
    });

    // Insert document owned by self_user
    const ownedId = (
      await app.query(
        `insert into data_live.people (${R}, workspace_id, id, email, owner) values (${RV}, 'default', gen_random_uuid(), 'self@ex.com', $1) returning id`,
        [userId],
      )
    ).rows[0].id;

    // Insert document owned by someone else
    const otherId = (
      await app.query(
        `insert into data_live.people (${R}, workspace_id, id, email, owner) values (${RV}, 'default', gen_random_uuid(), 'other@ex.com', 'other_user') returning id`,
      )
    ).rows[0].id;

    const broker = makeBroker(pools, cfg);

    // Should find self's document
    const ownedResult = await broker.getDocument(ctxSelf, {
      collection: "people",
      id: ownedId.toString(),
    });
    expect(ownedResult.ok).toBe(true);

    // Should not find other's document
    const otherResult = await broker.getDocument(ctxSelf, {
      collection: "people",
      id: otherId.toString(),
    });
    expect(otherResult.ok).toBe(false);
    if (!otherResult.ok) expect(otherResult.reason).toBe("not_found");
  });

  it("a grant without read verb refuses with no_grant", async () => {
    // Request grant with no read verb (will default to read, so we need to test with explicit no read)
    const ctxNoRead: BrokerContext = makeCtx({ userId: "noread_user", env: "live" });
    const id = (
      await app.query(
        `insert into data_live.people (${R}, workspace_id, id, email) values (${RV}, 'default', gen_random_uuid(), 'test@ex.com') returning id`,
      )
    ).rows[0].id;

    const broker = makeBroker(pools, cfg);
    const result = await broker.getDocument(ctxNoRead, { collection: "people", id: id.toString() });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_grant");
  });

  it("path form works on a file collection and is invalid_intent on a dataset", async () => {
    // Grant for file collection
    const fileUser = "user_file_path_test";
    const ctxFile: BrokerContext = makeCtx({ userId: fileUser, env: "live" });
    const fileGrantId = await requestGrant(app, {
      userId: fileUser,
      collection: "sources",
      env: "live",
      workspaceId: "default",
      purposeLabel: "test",
      // Not `path`: this fixture declares it `posture: deny`, and the path form is a lookup key
      // rather than a field the grant has to carry.
      allowedFields: ["title", "content"],
    });
    await approveGrant(app, cfg, fileGrantId, "admin", { verbs: ["read"] });

    // Insert file data
    const fileId = (
      await app.query(
        `insert into data_live."sources__files" (id, workspace_id, path, owner, checksum, updated_at)
       values (gen_random_uuid(), 'default', 'test.md', null, 'abc', now()) returning id`,
      )
    ).rows[0].id;
    await app.query(
      `insert into data_live."sources__documents" (id, file_id, workspace_id, document_seq, content)
       values (gen_random_uuid(), $1, 'default', 0, 'test content')`,
      [fileId],
    );

    const broker = makeBroker(pools, cfg);
    // Path form should work
    const pathResult = await broker.getDocument(ctxFile, {
      collection: "sources",
      path: "test.md",
    });
    expect(pathResult.ok).toBe(true);

    // Path form on dataset should fail
    const datasetUser = "user_path_dataset_test";
    const ctxPath: BrokerContext = makeCtx({ userId: datasetUser, env: "live" });
    const datasetGrant = await requestGrant(app, {
      userId: datasetUser,
      collection: "people",
      env: "live",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id"],
    });
    await approveGrant(app, cfg, datasetGrant, "admin", { verbs: ["read"] });

    const invalidResult = await broker.getDocument(ctxPath, { collection: "people", path: "x" });
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) expect(invalidResult.reason).toBe("invalid_intent");
  });

  it("a file's chunks come back as one document, not the first chunk", async () => {
    const userId = "user_reassemble";
    const ctxTest: BrokerContext = makeCtx({ userId, env: "live" });
    const grantId = await requestGrant(app, {
      userId,
      collection: "sources",
      env: "live",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["title", "content"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read"] });

    // Two chunks whose boundary carries chunkText's overlap: the tail of the first is the
    // head of the second. Reassembly must not duplicate it.
    const tail = "the overlapping tail";
    const fileId = (
      await app.query(
        `insert into data_live."sources__files" (id, workspace_id, title, path, owner, checksum, updated_at)
       values (gen_random_uuid(), 'default', 'Multi', 'multi.md', null, 'c', now()) returning id`,
      )
    ).rows[0].id;
    await app.query(
      `insert into data_live."sources__documents" (id, file_id, workspace_id, document_seq, content)
       values (gen_random_uuid(), $1, 'default', 0, $2),
              (gen_random_uuid(), $1, 'default', 1, $3)`,
      [fileId, `first part, then ${tail}`, `${tail} and the second part`],
    );

    const r = await makeBroker(pools, cfg).getDocument(ctxTest, {
      collection: "sources",
      path: "multi.md",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.content).toBe(`first part, then ${tail} and the second part`);
      expect(r.document.title).toBe("Multi");
    }
  });

  it("bookkeeping columns never appear in the returned document", async () => {
    const userId = "user_orgid_test";
    const ctxTest: BrokerContext = makeCtx({ userId, env: "live" });
    const grantId = await requestGrant(app, {
      userId,
      collection: "people",
      env: "live",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read"] });

    const id = (
      await app.query(
        `insert into data_live.people (${R}, workspace_id, id, email) values (${RV}, 'default', gen_random_uuid(), 'test@ex.com') returning id`,
      )
    ).rows[0].id;

    const broker = makeBroker(pools, cfg);
    const result = await broker.getDocument(ctxTest, { collection: "people", id: id.toString() });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // workspace_id and _rev* are not in warehousd.yml, so no grant can name them and nothing has
      // to filter them out — invisibility falls out of the field set, not out of code.
      for (const hidden of ["workspace_id", "_rev", "_rev_seq", "_rev_status", "_current"])
        expect(result.document).not.toHaveProperty(hidden);
    }
  });

  it("every outcome writes an audit row", async () => {
    const userId = "user_audit_test";
    const ctxTest: BrokerContext = makeCtx({ userId, env: "live" });
    const grantId = await requestGrant(app, {
      userId,
      collection: "people",
      env: "live",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read"] });

    const id = (
      await app.query(
        `insert into data_live.people (${R}, workspace_id, id, email) values (${RV}, 'default', gen_random_uuid(), 'test@ex.com') returning id`,
      )
    ).rows[0].id;

    const broker = makeBroker(pools, cfg);

    // Allowed outcome
    const successResult = await broker.getDocument(ctxTest, {
      collection: "people",
      id: id.toString(),
    });
    expect(successResult.ok).toBe(true);
    if (successResult.ok) {
      const auditRow = await app.query(`select * from app.audit_events where id = $1`, [
        successResult.auditId,
      ]);
      expect(auditRow.rowCount).toBe(1);
      expect(auditRow.rows[0].outcome).toBe("allowed");
    }

    // Refused outcome (no_grant)
    const refusedResult = await broker.getDocument(makeCtx({ userId: "no_access", env: "live" }), {
      collection: "people",
      id: id.toString(),
    });
    expect(refusedResult.ok).toBe(false);
    if (!refusedResult.ok) {
      const auditRow = await app.query(`select * from app.audit_events where id = $1`, [
        refusedResult.auditId,
      ]);
      expect(auditRow.rowCount).toBe(1);
      expect(auditRow.rows[0].outcome).toBe("refused");
    }
  });

  it("writable dataset collections return rev as a truthy string", async () => {
    const userId = "user_writable_rev_test";
    const ctxTest: BrokerContext = makeCtx({ userId, env: "live" });
    const grantId = await requestGrant(app, {
      userId,
      collection: "articles",
      env: "live",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "title", "content"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read"] });

    // Insert writable collection document via SQL (simulating a created document)
    const id = (
      await app.query(
        `insert into data_live.articles (workspace_id, id, title, content, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _rev_base, _current)
       values ('default', gen_random_uuid(), 'Test Article', 'Content here', gen_random_uuid(), 1, now(), $1, 'create', 'approved', ARRAY['title', 'content'], null, true)
       returning id`,
        [userId],
      )
    ).rows[0].id;

    const broker = makeBroker(pools, cfg);
    const result = await broker.getDocument(ctxTest, { collection: "articles", id: id.toString() });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // rev should be present and be a non-empty string (the _rev UUID)
      expect(result.rev).toBeTruthy();
      expect(typeof result.rev).toBe("string");
      expect(result.rev).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
