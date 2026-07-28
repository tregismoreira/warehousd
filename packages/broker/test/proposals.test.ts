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
        owner: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("proposals");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, devWrite: p.urls.devWrite, liveWrite: p.urls.liveWrite });
  broker = makeBroker(pools, cfg);
}, 60_000);

afterAll(async () => { await app.end(); await pools.end(); await p.end(); });

describe("broker.mutate proposals", () => {
  it("proposal_only mode + update → status: pending, document unchanged in query", async () => {
    const grantId = await requestGrant(app, {
      userId: "proposer", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, grantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    // Create a document to propose against
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'old@ex.com', 'Old Name', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    const ctx: BrokerContext = { userId: "proposer", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "new@ex.com" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("pending");
      expect(result.proposalId).toBeDefined();
      expect(result.proposalId).toMatch(/^[0-9a-f-]{36}$/);

      // Verify document is unchanged in query
      const queryResult = await broker.query(ctx, { collection: "people", fields: ["id", "email", "name"] });
      expect(queryResult.ok).toBe(true);
      if (queryResult.ok) {
        const doc = queryResult.documents.find((d) => d.id === docId);
        expect(doc).toBeDefined();
        if (doc) {
          expect(doc.email).toBe("old@ex.com");
          expect(doc.name).toBe("Old Name");
        }
      }
    }
  });

  it("pending revision not readable through query by anyone", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer2", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const readerGrantId = await requestGrant(app, {
      userId: "reader", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, readerGrantId, "admin", { verbs: ["read"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'first@ex.com', 'First', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Propose a change
    const proposerCtx: BrokerContext = { userId: "proposer2", env: "dev", orgId: "default" };
    const proposeRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { name: "Proposed Name" },
    });
    expect(proposeRes.ok).toBe(true);

    // Reader should not see the change
    const readerCtx: BrokerContext = { userId: "reader", env: "dev", orgId: "default" };
    const queryResult = await broker.query(readerCtx, { collection: "people", fields: ["id", "name"] });
    expect(queryResult.ok).toBe(true);
    if (queryResult.ok) {
      const doc = queryResult.documents.find((d) => d.id === docId);
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.name).toBe("First");
      }
    }
  });

  it("approve promotes pending to current, visible in query", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer3", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'second@ex.com', 'Second', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id, _rev`);
    const docId = createRes.rows[0].id;

    // Propose a change
    const proposerCtx: BrokerContext = { userId: "proposer3", env: "dev", orgId: "default" };
    const proposeRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "new_email@ex.com" },
    });
    expect(proposeRes.ok).toBe(true);
    if (!proposeRes.ok) throw new Error("proposal failed");
    const proposalId = proposeRes.proposalId;

    // Approve the proposal
    const approverCtx: BrokerContext = { userId: "approver", env: "dev", orgId: "default" };
    const approveRes = await broker.approveProposal(approverCtx, proposalId);
    expect(approveRes.ok).toBe(true);
    if (approveRes.ok) {
      expect(approveRes.rev).toMatch(/^[0-9a-f-]{36}$/);
    }

    // Verify document is updated in query
    const queryResult = await broker.query(proposerCtx, { collection: "people", fields: ["id", "email"] });
    expect(queryResult.ok).toBe(true);
    if (queryResult.ok) {
      const doc = queryResult.documents.find((d) => d.id === docId);
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.email).toBe("new_email@ex.com");
      }
    }
  });

  it("reject sets _rev_status to rejected, document unchanged", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer4", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver2", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'third@ex.com', 'Third', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Propose a change
    const proposerCtx: BrokerContext = { userId: "proposer4", env: "dev", orgId: "default" };
    const proposeRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { name: "Rejected Name" },
    });
    expect(proposeRes.ok).toBe(true);
    if (!proposeRes.ok) throw new Error("proposal failed");
    const proposalId = proposeRes.proposalId;

    // Reject the proposal
    const approverCtx: BrokerContext = { userId: "approver2", env: "dev", orgId: "default" };
    const rejectRes = await broker.rejectProposal(approverCtx, proposalId);
    expect(rejectRes.ok).toBe(true);

    // Verify document is unchanged
    const queryResult = await broker.query(proposerCtx, { collection: "people", fields: ["id", "name"] });
    expect(queryResult.ok).toBe(true);
    if (queryResult.ok) {
      const doc = queryResult.documents.find((d) => d.id === docId);
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.name).toBe("Third");
      }
    }

    // Verify rejected row still exists
    const rejectedRow = await app.query(`select _rev_status from data_synth.people where _rev = $1`, [proposalId]);
    expect(rejectedRow.rows.length).toBe(1);
    expect(rejectedRow.rows[0]._rev_status).toBe("rejected");
  });

  it("revoke approver's grant, then approve → refused, no state change", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer5", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver3", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'fourth@ex.com', 'Fourth', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Propose a change
    const proposerCtx: BrokerContext = { userId: "proposer5", env: "dev", orgId: "default" };
    const proposeRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "revoked@ex.com" },
    });
    expect(proposeRes.ok).toBe(true);
    if (!proposeRes.ok) throw new Error("proposal failed");
    const proposalId = proposeRes.proposalId;

    // Revoke approver's grant
    await app.query(
      `update app.grants set status = 'revoked' where id = $1`,
      [approverGrantId]);

    // Try to approve → should be refused
    const approverCtx: BrokerContext = { userId: "approver3", env: "dev", orgId: "default" };
    const approveRes = await broker.approveProposal(approverCtx, proposalId);
    expect(approveRes.ok).toBe(false);
    if (!approveRes.ok) {
      expect(approveRes.reason).toBe("no_grant");
    }

    // Verify proposal is still pending
    const proposalRow = await app.query(`select _rev_status from data_synth.people where _rev = $1`, [proposalId]);
    expect(proposalRow.rows.length).toBe(1);
    expect(proposalRow.rows[0]._rev_status).toBe("pending");

    // Verify document is still unchanged
    const queryResult = await broker.query(proposerCtx, { collection: "people", fields: ["id", "email"] });
    expect(queryResult.ok).toBe(true);
    if (queryResult.ok) {
      const doc = queryResult.documents.find((d) => d.id === docId);
      expect(doc).toBeDefined();
      if (doc) {
        expect(doc.email).toBe("fourth@ex.com");
      }
    }
  });
});
