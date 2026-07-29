import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
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
        name: { type: "text", posture: { read: "allow", write: "allow" } },
        dept: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("proposal-merge");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, devWrite: p.urls.devWrite, liveWrite: p.urls.liveWrite });
  broker = makeBroker(pools, cfg);
}, 60_000);

afterAll(async () => { await app.end(); await pools.end(); await p.end(); });

describe("broker.approveProposal merge logic", () => {
  it("two disjoint field proposals both approve cleanly, final doc carries both", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_disjoint", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_disjoint", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document with initial values
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'test@ex.com', 'Test', 'Engineering', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Proposal 1: update email
    const proposerCtx: BrokerContext = { userId: "proposer_disjoint", env: "dev", orgId: "default" };
    const prop1Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "email1@ex.com" },
    });
    expect(prop1Res.ok).toBe(true);
    if (!prop1Res.ok) throw new Error("proposal 1 failed");
    const prop1Id = prop1Res.proposalId;

    // Proposal 2: update name (different field)
    const prop2Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { name: "Updated Name" },
    });
    expect(prop2Res.ok).toBe(true);
    if (!prop2Res.ok) throw new Error("proposal 2 failed");
    const prop2Id = prop2Res.proposalId;

    // Approve both
    const approverCtx: BrokerContext = { userId: "approver_disjoint", env: "dev", orgId: "default" };
    const approve1Res = await broker.approveProposal(approverCtx, prop1Id);
    expect(approve1Res.ok).toBe(true);

    const approve2Res = await broker.approveProposal(approverCtx, prop2Id);
    expect(approve2Res.ok).toBe(true);

    // Verify final document has both changes
    const queryResult = await broker.query(proposerCtx, { collection: "people", fields: ["id", "email", "name"] });
    expect(queryResult.ok).toBe(true);
    if (queryResult.ok) {
      const doc = queryResult.documents.find((d) => d.id === docId);
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.email).toBe("email1@ex.com");
        expect(doc.name).toBe("Updated Name");
      }
    }
  });

  it("two overlapping field proposals: second refuses with conflict", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_overlap", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_overlap", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'overlap@ex.com', 'Overlap', 'Sales', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Proposal 1: update email
    const proposerCtx: BrokerContext = { userId: "proposer_overlap", env: "dev", orgId: "default" };
    const prop1Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "email_overlap1@ex.com" },
    });
    expect(prop1Res.ok).toBe(true);
    if (!prop1Res.ok) throw new Error("proposal 1 failed");
    const prop1Id = prop1Res.proposalId;

    // Proposal 2: also update email (overlapping field)
    const prop2Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "email_overlap2@ex.com" },
    });
    expect(prop2Res.ok).toBe(true);
    if (!prop2Res.ok) throw new Error("proposal 2 failed");
    const prop2Id = prop2Res.proposalId;

    // Approve first
    const approverCtx: BrokerContext = { userId: "approver_overlap", env: "dev", orgId: "default" };
    const approve1Res = await broker.approveProposal(approverCtx, prop1Id);
    expect(approve1Res.ok).toBe(true);

    // Try to approve second → should fail with conflict
    const approve2Res = await broker.approveProposal(approverCtx, prop2Id);
    expect(approve2Res.ok).toBe(false);
    if (!approve2Res.ok) {
      expect(approve2Res.reason).toBe("conflict");
    }
  });

  it("stale base with overlap refuses conflict", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_stale", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const directGrantId = await requestGrant(app, {
      userId: "direct_update", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, directGrantId, "admin", { verbs: ["read", "update"] });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_stale", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'stale@ex.com', 'Stale', 'HR', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Proposal: update email (based on rev_seq 1)
    const proposerCtx: BrokerContext = { userId: "proposer_stale", env: "dev", orgId: "default" };
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "proposal_email@ex.com" },
    });
    expect(propRes.ok).toBe(true);
    if (!propRes.ok) throw new Error("proposal failed");
    const propId = propRes.proposalId;

    // Make a direct update to the same field (email) - this advances _rev_seq to 2
    const directCtx: BrokerContext = { userId: "direct_update", env: "dev", orgId: "default" };
    const directRes = await broker.mutate(directCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "direct_email@ex.com" },
    });
    expect(directRes.ok).toBe(true);

    // Try to approve the stale proposal with overlapping field → should fail
    const approverCtx: BrokerContext = { userId: "approver_stale", env: "dev", orgId: "default" };
    const approveRes = await broker.approveProposal(approverCtx, propId);
    expect(approveRes.ok).toBe(false);
    if (!approveRes.ok) {
      expect(approveRes.reason).toBe("conflict");
    }
  });

  it("stale base with no overlap promotes", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_stale_ok", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const directGrantId = await requestGrant(app, {
      userId: "direct_update2", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, directGrantId, "admin", { verbs: ["read", "update"] });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_stale_ok", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'stale_ok@ex.com', 'Stale OK', 'Finance', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Proposal: update name (based on rev_seq 1)
    const proposerCtx: BrokerContext = { userId: "proposer_stale_ok", env: "dev", orgId: "default" };
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { name: "Proposal Name" },
    });
    expect(propRes.ok).toBe(true);
    if (!propRes.ok) throw new Error("proposal failed");
    const propId = propRes.proposalId;

    // Make a direct update to a different field (email) - this advances _rev_seq to 2
    const directCtx: BrokerContext = { userId: "direct_update2", env: "dev", orgId: "default" };
    const directRes = await broker.mutate(directCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "new_email@ex.com" },
    });
    expect(directRes.ok).toBe(true);

    // Approve the stale proposal with no overlapping field → should succeed
    const approverCtx: BrokerContext = { userId: "approver_stale_ok", env: "dev", orgId: "default" };
    const approveRes = await broker.approveProposal(approverCtx, propId);
    expect(approveRes.ok).toBe(true);

    // Verify final document has both changes
    const queryResult = await broker.query(proposerCtx, { collection: "people", fields: ["id", "email", "name"] });
    expect(queryResult.ok).toBe(true);
    if (queryResult.ok) {
      const doc = queryResult.documents.find((d) => d.id === docId);
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.email).toBe("new_email@ex.com");
        expect(doc.name).toBe("Proposal Name");
      }
    }
  });

  it("merged revision carries proposer as _rev_by", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_rev_by", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_rev_by", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'rev_by@ex.com', 'Rev By', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Propose
    const proposerCtx: BrokerContext = { userId: "proposer_rev_by", env: "dev", orgId: "default" };
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "new_rev_by@ex.com" },
    });
    expect(propRes.ok).toBe(true);
    if (!propRes.ok) throw new Error("proposal failed");
    const propId = propRes.proposalId;

    // Approve
    const approverCtx: BrokerContext = { userId: "approver_rev_by", env: "dev", orgId: "default" };
    const approveRes = await broker.approveProposal(approverCtx, propId);
    expect(approveRes.ok).toBe(true);
    if (!approveRes.ok) throw new Error("approval failed");

    // Check that _rev_by is the proposer, not the approver
    const row = await app.query(
      `select _rev_by, _rev from data_synth.people where id = $1 and _current`,
      [docId]);
    expect(row.rows.length).toBe(1);
    expect(row.rows[0]._rev_by).toBe("proposer_rev_by");
  });

  it("_rev_seq is strictly increasing per document", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_seq", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_seq", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'seq@ex.com', 'Seq', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    const proposerCtx: BrokerContext = { userId: "proposer_seq", env: "dev", orgId: "default" };
    const approverCtx: BrokerContext = { userId: "approver_seq", env: "dev", orgId: "default" };

    // Proposal 1
    const prop1Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "seq1@ex.com" },
    });
    expect(prop1Res.ok).toBe(true);
    if (!prop1Res.ok) throw new Error("proposal 1 failed");
    const approve1Res = await broker.approveProposal(approverCtx, prop1Res.proposalId);
    expect(approve1Res.ok).toBe(true);

    // Proposal 2
    const prop2Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { name: "Seq Updated" },
    });
    expect(prop2Res.ok).toBe(true);
    if (!prop2Res.ok) throw new Error("proposal 2 failed");
    const approve2Res = await broker.approveProposal(approverCtx, prop2Res.proposalId);
    expect(approve2Res.ok).toBe(true);

    // Check all revisions
    const rows = await app.query(
      `select _rev_seq, _rev_status from data_synth.people where id = $1 order by _rev_seq`,
      [docId]);
    expect(rows.rows.length).toBeGreaterThanOrEqual(3);
    const seqs = rows.rows.map((r) => Number(r._rev_seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });
});
