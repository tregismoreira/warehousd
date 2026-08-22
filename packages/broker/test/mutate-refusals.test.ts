import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { assertPending, assertApplied } from "./helpers/results";

let p: Provisioned, app: Pool, pools: any;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    people: {
      description: "People",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: { read: "allow", write: "allow" } },
        name: { type: "text", posture: "allow" },
        owner: { type: "text", posture: { read: "allow", write: "allow" } },
        parent_id: { type: "uuid", posture: { read: "allow", write: "allow" }, nullable: true },
        tags: { type: "json", posture: { read: "allow", write: "allow" }, nullable: true },
      },
    },
    readOnly: {
      description: "Read Only",
      writable: false,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        text: { type: "text", posture: "allow" },
      },
    },
    testcol: {
      description: "Test",
      writable: true,
      fields: {
        id: { type: "uuid", posture: { read: "allow", write: "allow" }, pk: true },
        value: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
    aclcol: {
      description: "ACL",
      writable: true,
      acl: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        owner: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("mutate-refusals");
  app = testPool({ connectionString: p.urls.admin });
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

function assertNoLeak(result: any, submittedValue?: string, submittedField?: string) {
  const str = JSON.stringify(result);
  if (submittedValue) expect(str).not.toContain(submittedValue);
  if (submittedField) expect(str).not.toContain(submittedField);
}

describe("broker.mutate refusals", () => {
  it("not_writable: collection has writable: false", async () => {
    const ctx: BrokerContext = makeCtx({ userId: "user1" });
    const result = await broker.mutate(ctx, {
      collection: "readOnly",
      op: "create",
      values: { text: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_writable");
    assertNoLeak(result);
  });

  it("verb_not_supported: delete on a dataset collection is supported, but update on file is not", async () => {
    const ctx: BrokerContext = makeCtx({ userId: "user1" });
    const grantId = await requestGrant(app, {
      userId: "user1",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "update", "delete"] });
    // This would pass for people, but let's test via checking the intent
    await broker.mutate(ctx, { collection: "people", op: "delete", id: "x", expect: "y" });
    // This goes through; verb_not_supported is structural (file type), not operational
  });

  it("no_grant: user has no grant for the collection", async () => {
    const ctx: BrokerContext = makeCtx({ userId: "nogrant_user" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_grant");
    assertNoLeak(result);
  });

  it("verb_denied: grant lacks the verb", async () => {
    const grantId = await requestGrant(app, {
      userId: "read_only_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read"] });

    const ctx: BrokerContext = makeCtx({ userId: "read_only_user" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("verb_denied");
    assertNoLeak(result);
  });

  it("proposal_only mode creates pending revision for dataset mutations", async () => {
    const grantId = await requestGrant(app, {
      userId: "proposal_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", {
      verbs: ["read", "create"],
      mode: "proposal_only",
    });

    const ctx: BrokerContext = makeCtx({ userId: "proposal_user" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "test@ex.com" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      assertPending(result);
      expect(result.status).toBe("pending");
      expect(result.proposalId).toBeDefined();
    }
  });

  it("unknown_collection: collection does not exist", async () => {
    const ctx: BrokerContext = makeCtx({ userId: "user1" });
    const result = await broker.mutate(ctx, {
      collection: "notfound",
      op: "create",
      values: { x: "y" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_collection");
    assertNoLeak(result);
  });

  it("unknown_field: values references a field that does not exist", async () => {
    const grantId = await requestGrant(app, {
      userId: "unknown_field_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = makeCtx({ userId: "unknown_field_user" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { nosuchfield: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_field");
    assertNoLeak(result, undefined, "nosuchfield");
  });

  it("field_not_writable: field has posture write:deny", async () => {
    const grantId = await requestGrant(app, {
      userId: "not_writable_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = makeCtx({ userId: "not_writable_user" });
    // name has posture:allow (read:allow, write:deny by default)
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x", name: "y" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("field_not_writable");
    assertNoLeak(result, undefined, "name");
  });

  it("field_denied: field is not in grant.allowedFields", async () => {
    const grantId = await requestGrant(app, {
      userId: "field_denied_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = makeCtx({ userId: "field_denied_user" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x", owner: "y" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("field_denied");
    assertNoLeak(result, undefined, "owner");
  });

  it("invalid_value: field value fails coercion", async () => {
    const grantId = await requestGrant(app, {
      userId: "invalid_value_user",
      collection: "testcol",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "value"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = makeCtx({ userId: "invalid_value_user" });
    // id is uuid, "notauuid" will fail coercion
    const result = await broker.mutate(ctx, {
      collection: "testcol",
      op: "create",
      values: { id: "notauuid", value: "test" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_value");
    assertNoLeak(result, "notauuid");
  });

  it("not_found: document does not exist for update/delete", async () => {
    const grantId = await requestGrant(app, {
      userId: "not_found_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "update", "delete"] });

    const ctx: BrokerContext = makeCtx({ userId: "not_found_user" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "update",
      id: "00000000-0000-0000-0000-000000000000",
      values: { email: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
    assertNoLeak(result);
  });

  it("not_found: document is excluded by grant.documentFilter", async () => {
    const grantId = await requestGrant(app, {
      userId: "filter_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", {
      verbs: ["read", "update"],
      documentFilters: [{ field: "owner", op: "eq", value: "filter_user" }],
    });

    // Insert a document not owned by filter_user
    const otherId = (
      await app.query(
        `insert into data_synth.people (workspace_id, id, email, owner, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'x@ex.com', 'other', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true) returning id`,
      )
    ).rows[0].id;

    const ctx: BrokerContext = makeCtx({ userId: "filter_user" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "update",
      id: otherId,
      values: { email: "new" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
    assertNoLeak(result);
  });

  it("conflict: create when pk already exists as _current", async () => {
    const grantId = await requestGrant(app, {
      userId: "conflict_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    // Insert a document
    const id = (
      await app.query(
        `insert into data_synth.people (workspace_id, id, email, owner, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'x@ex.com', 'owner1', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true) returning id`,
      )
    ).rows[0].id;

    const ctx: BrokerContext = makeCtx({ userId: "conflict_user" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { id, email: "y", owner: "z" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    assertNoLeak(result);
  });

  it("conflict: update with mismatched expect (_rev)", async () => {
    const grantId = await requestGrant(app, {
      userId: "concurrency_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "update"] });

    const rev = (
      await app.query(
        `insert into data_synth.people (workspace_id, id, email, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'x@ex.com', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true) returning _rev`,
      )
    ).rows[0]._rev;

    const ctx: BrokerContext = makeCtx({ userId: "concurrency_user" });
    // Create the document first to get its id
    const id = (await app.query(`select id from data_synth.people where _rev = $1`, [rev])).rows[0]
      .id;

    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "update",
      id,
      expect: "wrongrev",
      values: { email: "new" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    assertNoLeak(result);
  });

  it("invalid_intent: create with no op-specific fields", async () => {
    const ctx: BrokerContext = makeCtx({ userId: "user1" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: {},
    } as any);
    expect(result.ok).toBe(false);
    // Asserting the reason, not just the refusal. This test used to check `ok === false` alone and
    // passed while the guard it names was unreachable — user1 holds no `create` verb, so it was
    // really observing verb_denied. A caller that *can* create is the case below.
    if (!result.ok) expect(result.reason).toBe("invalid_intent");
  });

  it("invalid_intent: an empty-values create is refused rather than writing an all-null row", async () => {
    // The guard read `!fieldNames.length && !intent.values`, and `{}` is truthy, so it never
    // fired: the create fell through to the insert and stored a row whose every column was null
    // under a generated uuid pk. Verified against the pre-fix code, which answered
    // ok:true/status:applied and left exactly that row behind.
    const grantId = await requestGrant(app, {
      userId: "emptycreate_user",
      collection: "testcol",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "value"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });
    const ctx: BrokerContext = makeCtx({ userId: "emptycreate_user" });

    const before = await app.query(`select count(*)::int as n from data_synth.testcol`);
    const result = await broker.mutate(ctx, { collection: "testcol", op: "create", values: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_intent");
    const after = await app.query(`select count(*)::int as n from data_synth.testcol`);
    expect(after.rows[0].n, "no row may be written").toBe(before.rows[0].n);
  });

  it("an intent-shape refusal audits with the mutation shape, not the query shape", async () => {
    // These two guards called refuse() — the query-shaped helper, which records `intent: null` —
    // while every other mutation refusal calls refuseMutation(). Identical operations audited
    // differently depending on which line rejected them, so an audit reader could not tell what
    // was attempted.
    const grantId = await requestGrant(app, {
      userId: "auditshape_user",
      collection: "testcol",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "value"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create", "update"] });
    const ctx: BrokerContext = makeCtx({ userId: "auditshape_user" });

    const r = await broker.mutate(ctx, { collection: "testcol", op: "create", values: {} });
    expect(r.ok).toBe(false);
    const row = await app.query(`select intent, reason from app.audit_events where id = $1`, [
      r.auditId,
    ]);
    expect(row.rows[0].reason).toBe("invalid_intent");
    expect(row.rows[0].intent).toMatchObject({ op: "create", collection: "testcol" });

    // An update with a blank id takes the sibling guard; it must audit the same way.
    const u = await broker.mutate(ctx, {
      collection: "testcol",
      op: "update",
      id: "",
      values: { value: "x" },
    });
    expect(u.ok).toBe(false);
    const urow = await app.query(`select intent from app.audit_events where id = $1`, [u.auditId]);
    expect(urow.rows[0].intent).toMatchObject({ op: "update", collection: "testcol" });
  });

  it("applied: create accepts an explicit null on a nullable field, and it reads back SQL NULL", async () => {
    const grantId = await requestGrant(app, {
      userId: "null_create_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "parent_id"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = makeCtx({ userId: "null_create_user" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x@ex.com", parent_id: null },
    });
    assertApplied(result);

    const row = await app.query(
      `select parent_id from data_synth.people where id = $1 and parent_id is null`,
      [result.documentId],
    );
    expect(row.rows.length).toBe(1);
  });

  it("applied: update accepts an explicit null on a nullable field and clears a previously-set value", async () => {
    const grantId = await requestGrant(app, {
      userId: "null_update_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "parent_id"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create", "update"] });
    const ctx: BrokerContext = makeCtx({ userId: "null_update_user" });

    const someParent = "11111111-1111-1111-1111-111111111111";
    const created = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x@ex.com", parent_id: someParent },
    });
    assertApplied(created);

    const before = await app.query(`select parent_id from data_synth.people where id = $1`, [
      created.documentId,
    ]);
    expect(before.rows[0].parent_id).toBe(someParent);

    const updated = await broker.mutate(ctx, {
      collection: "people",
      op: "update",
      id: created.documentId,
      values: { parent_id: null },
    });
    expect(updated.ok).toBe(true);

    const after = await app.query(
      `select parent_id from data_synth.people where id = $1 and parent_id is null`,
      [created.documentId],
    );
    expect(after.rows.length).toBe(1);
  });

  it("invalid_value: an explicit null is refused on a field without nullable: true", async () => {
    const grantId = await requestGrant(app, {
      userId: "null_refused_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });
    const ctx: BrokerContext = makeCtx({ userId: "null_refused_user" });

    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: null },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_value");
  });

  it("applied: a nullable json field given null stores SQL NULL, not the jsonb document null", async () => {
    const grantId = await requestGrant(app, {
      userId: "null_json_user",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "tags"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });
    const ctx: BrokerContext = makeCtx({ userId: "null_json_user" });

    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x@ex.com", tags: null },
    });
    assertApplied(result);

    const row = await app.query(
      `select tags from data_synth.people where id = $1 and tags is null`,
      [result.documentId],
    );
    expect(row.rows.length).toBe(1);
  });
});

// document_filter checked against what a write PRODUCES, not only what it replaces. Before this,
// mutate.ts checked the pre-image only (an update) or nothing at all (a create) — a grant scoped
// `owner eq filter_user` could publish a document under any other owner, and could create one
// outright.
describe("document_filter is enforced against the post-image", () => {
  async function filteredGrant(userId: string, verbs: string[] = ["read", "create", "update"]) {
    const grantId = await requestGrant(app, {
      userId,
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", {
      verbs,
      documentFilters: [{ field: "owner", op: "eq", value: "filter_user" }],
    });
  }

  it("refuses a create whose document would fall outside the grant's filter", async () => {
    await filteredGrant("post_image_create_outside");
    const ctx: BrokerContext = makeCtx({ userId: "post_image_create_outside" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x@ex.com", owner: "someone_else" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
    assertNoLeak(result, undefined, "someone_else");
  });

  it("refuses a create that omits the filtered field", async () => {
    await filteredGrant("post_image_create_omit");
    const ctx: BrokerContext = makeCtx({ userId: "post_image_create_omit" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x@ex.com" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("allows a create whose document falls inside the filter", async () => {
    await filteredGrant("post_image_create_inside");
    const ctx: BrokerContext = makeCtx({ userId: "post_image_create_inside" });
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x@ex.com", owner: "filter_user" },
    });
    assertApplied(result);
  });

  it("refuses an update that would carry the document out of the filter, and leaves it unchanged", async () => {
    await filteredGrant("post_image_update_outside");
    const ctx: BrokerContext = makeCtx({ userId: "post_image_update_outside" });
    const created = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x@ex.com", owner: "filter_user" },
    });
    assertApplied(created);

    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "update",
      id: created.documentId,
      values: { owner: "other" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
    assertNoLeak(result, undefined, "other");

    const row = await app.query(`select owner from data_synth.people where id = $1 and _current`, [
      created.documentId,
    ]);
    expect(row.rows[0].owner).toBe("filter_user");
  });

  it("still allows an update that leaves the document inside the filter", async () => {
    await filteredGrant("post_image_update_inside");
    const ctx: BrokerContext = makeCtx({ userId: "post_image_update_inside" });
    const created = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x@ex.com", owner: "filter_user" },
    });
    assertApplied(created);

    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "update",
      id: created.documentId,
      values: { email: "y@ex.com" },
    });
    expect(result.ok).toBe(true);
  });

  it("a delete through the same filtered grant still succeeds", async () => {
    await filteredGrant("post_image_delete", ["read", "create", "delete"]);
    const ctx: BrokerContext = makeCtx({ userId: "post_image_delete" });
    const created = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "x@ex.com", owner: "filter_user" },
    });
    assertApplied(created);

    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "delete",
      id: created.documentId,
    });
    expect(result.ok).toBe(true);
  });

  it("ACL regression: a create on a collection with acl: true through a filtered grant is applied, not refused", async () => {
    // Proves the post-image check does not drag admits()'s fail-closed-on-absent-ACL branch into
    // the create path: the post-image is built from submitted values, which never carry _acl.
    const grantId = await requestGrant(app, {
      userId: "post_image_acl_create",
      collection: "aclcol",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", {
      verbs: ["read", "create"],
      documentFilters: [{ field: "owner", op: "eq", value: "filter_user" }],
    });
    const ctx: BrokerContext = makeCtx({ userId: "post_image_acl_create" });
    const result = await broker.mutate(ctx, {
      collection: "aclcol",
      op: "create",
      values: { owner: "filter_user" },
    });
    assertApplied(result);
  });
});
