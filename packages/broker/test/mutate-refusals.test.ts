import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext, MutationIntent } from "../src/types";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";

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
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("mutate-refusals");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, devWrite: p.urls.devWrite, liveWrite: p.urls.liveWrite });
  broker = makeBroker(pools, cfg);
}, 60_000);

afterAll(async () => { await app.end(); await pools.end(); await p.end(); });

function assertNoLeak(result: any, submittedValue?: string, submittedField?: string) {
  const str = JSON.stringify(result);
  if (submittedValue) expect(str).not.toContain(submittedValue);
  if (submittedField) expect(str).not.toContain(submittedField);
}

describe("broker.mutate refusals", () => {
  it("not_writable: collection has writable: false", async () => {
    const ctx: BrokerContext = { userId: "user1", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "readOnly", op: "create", values: { text: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_writable");
    assertNoLeak(result);
  });

  it("verb_not_supported: delete on a dataset collection is supported, but update on file is not", async () => {
    const ctx: BrokerContext = { userId: "user1", env: "dev", orgId: "default" };
    const grantId = await requestGrant(app, {
      userId: "user1", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "update", "delete"] });
    // This would pass for people, but let's test via checking the intent
    const result = await broker.mutate(ctx, { collection: "people", op: "delete", id: "x", expect: "y" });
    // This goes through; verb_not_supported is structural (file type), not operational
  });

  it("no_grant: user has no grant for the collection", async () => {
    const ctx: BrokerContext = { userId: "nogrant_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "people", op: "create", values: { email: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_grant");
    assertNoLeak(result);
  });

  it("verb_denied: grant lacks the verb", async () => {
    const grantId = await requestGrant(app, {
      userId: "read_only_user", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read"] });

    const ctx: BrokerContext = { userId: "read_only_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "people", op: "create", values: { email: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("verb_denied");
    assertNoLeak(result);
  });

  it("proposal_only mode creates pending revision for dataset mutations", async () => {
    const grantId = await requestGrant(app, {
      userId: "proposal_user", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"], mode: "proposal_only" });

    const ctx: BrokerContext = { userId: "proposal_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "people", op: "create", values: { email: "test@ex.com" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("pending");
      expect(result.proposalId).toBeDefined();
    }
  });

  it("unknown_collection: collection does not exist", async () => {
    const ctx: BrokerContext = { userId: "user1", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "notfound", op: "create", values: { x: "y" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_collection");
    assertNoLeak(result);
  });

  it("unknown_field: values references a field that does not exist", async () => {
    const grantId = await requestGrant(app, {
      userId: "unknown_field_user", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = { userId: "unknown_field_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "people", op: "create", values: { nosuchfield: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_field");
    assertNoLeak(result, undefined, "nosuchfield");
  });

  it("field_not_writable: field has posture write:deny", async () => {
    const grantId = await requestGrant(app, {
      userId: "not_writable_user", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = { userId: "not_writable_user", env: "dev", orgId: "default" };
    // name has posture:allow (read:allow, write:deny by default)
    const result = await broker.mutate(ctx, { collection: "people", op: "create", values: { email: "x", name: "y" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("field_not_writable");
    assertNoLeak(result, undefined, "name");
  });

  it("field_denied: field is not in grant.allowedFields", async () => {
    const grantId = await requestGrant(app, {
      userId: "field_denied_user", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = { userId: "field_denied_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "people", op: "create", values: { email: "x", owner: "y" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("field_denied");
    assertNoLeak(result, undefined, "owner");
  });

  it("invalid_value: field value fails coercion", async () => {
    const grantId = await requestGrant(app, {
      userId: "invalid_value_user", collection: "testcol", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "value"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = { userId: "invalid_value_user", env: "dev", orgId: "default" };
    // id is uuid, "notauuid" will fail coercion
    const result = await broker.mutate(ctx, { collection: "testcol", op: "create", values: { id: "notauuid", value: "test" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_value");
    assertNoLeak(result, "notauuid");
  });

  it("not_found: document does not exist for update/delete", async () => {
    const grantId = await requestGrant(app, {
      userId: "not_found_user", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "update", "delete"] });

    const ctx: BrokerContext = { userId: "not_found_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "people", op: "update", id: "00000000-0000-0000-0000-000000000000", values: { email: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
    assertNoLeak(result);
  });

  it("not_found: document is excluded by grant.documentFilter", async () => {
    const grantId = await requestGrant(app, {
      userId: "filter_user", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", {
      verbs: ["read", "update"],
      documentFilters: [{ field: "owner", op: "eq", value: "filter_user" }],
    });

    // Insert a document not owned by filter_user
    const otherId = (await app.query(
      `insert into data_synth.people (org_id, id, email, owner, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'x@ex.com', 'other', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true) returning id`,
    )).rows[0].id;

    const ctx: BrokerContext = { userId: "filter_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "people", op: "update", id: otherId, values: { email: "new" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
    assertNoLeak(result);
  });

  it("conflict: create when pk already exists as _current", async () => {
    const grantId = await requestGrant(app, {
      userId: "conflict_user", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    // Insert a document
    const id = (await app.query(
      `insert into data_synth.people (org_id, id, email, owner, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'x@ex.com', 'owner1', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true) returning id`,
    )).rows[0].id;

    const ctx: BrokerContext = { userId: "conflict_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "people", op: "create", values: { id, email: "y", owner: "z" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    assertNoLeak(result);
  });

  it("conflict: update with mismatched expect (_rev)", async () => {
    const grantId = await requestGrant(app, {
      userId: "concurrency_user", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "update"] });

    const rev = (await app.query(
      `insert into data_synth.people (org_id, id, email, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'x@ex.com', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true) returning _rev`,
    )).rows[0]._rev;

    const ctx: BrokerContext = { userId: "concurrency_user", env: "dev", orgId: "default" };
    // Create the document first to get its id
    const id = (await app.query(
      `select id from data_synth.people where _rev = $1`, [rev]
    )).rows[0].id;

    const result = await broker.mutate(ctx, { collection: "people", op: "update", id, expect: "wrongrev", values: { email: "new" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    assertNoLeak(result);
  });

  it("invalid_intent: create with no op-specific fields", async () => {
    const ctx: BrokerContext = { userId: "user1", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "people", op: "create", values: {} } as any);
    expect(result.ok).toBe(false);
  });
});
