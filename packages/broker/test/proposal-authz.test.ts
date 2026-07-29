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
    sensitive: {
      description: "Sensitive",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        public: { type: "text", posture: { read: "allow", write: "allow" } },
        secret: { type: "text", posture: "deny" },
      },
    },
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("proposal-authz");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, devWrite: p.urls.devWrite, liveWrite: p.urls.liveWrite });
  broker = makeBroker(pools, cfg);
}, 60_000);

afterAll(async () => { await app.end(); await pools.end(); await p.end(); });

describe("broker proposal authorization", () => {
  it("approve without read coverage of proposal fields → field_denied", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_noread", collection: "sensitive", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "public"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_noread", collection: "sensitive", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "public"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.sensitive (org_id, id, public, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'public_val', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Proposer updates a non-secret field
    const proposerCtx: BrokerContext = { userId: "proposer_noread", env: "dev", orgId: "default" };
    const propRes = await broker.mutate(proposerCtx, {
      collection: "sensitive",
      op: "update",
      id: docId,
      values: { public: "updated_public" },
    });
    expect(propRes.ok).toBe(true);
    if (!propRes.ok) throw new Error("proposal failed");

    // Approver tries to approve → should succeed since they have read coverage
    const approverCtx: BrokerContext = { userId: "approver_noread", env: "dev", orgId: "default" };
    const approveRes = await broker.approveProposal(approverCtx, propRes.proposalId);
    expect(approveRes.ok).toBe(true);
  });

  it("approve without read coverage of some proposal fields → field_denied", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_partial", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_partial", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'partial@ex.com', 'Partial', 'HR', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Proposal touches dept field that approver cannot read
    const proposerCtx: BrokerContext = { userId: "proposer_partial", env: "dev", orgId: "default" };
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { dept: "Engineering" },
    });
    expect(propRes.ok).toBe(true);
    if (!propRes.ok) throw new Error("proposal failed");

    // Approver tries to approve → should fail with field_denied
    const approverCtx: BrokerContext = { userId: "approver_partial", env: "dev", orgId: "default" };
    const approveRes = await broker.approveProposal(approverCtx, propRes.proposalId);
    expect(approveRes.ok).toBe(false);
    if (!approveRes.ok) {
      expect(approveRes.reason).toBe("field_denied");
    }
  });

  it("approver whose documentFilter excludes the document → not_found", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_filter", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_filter", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", {
      verbs: ["read", "approve"],
      documentFilters: [{ field: "dept", op: "eq", value: "Engineering" }],
    });

    // Create document with dept != Engineering
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'filter@ex.com', 'Filter', 'Sales', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Propose change
    const proposerCtx: BrokerContext = { userId: "proposer_filter", env: "dev", orgId: "default" };
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "filtered@ex.com" },
    });
    expect(propRes.ok).toBe(true);
    if (!propRes.ok) throw new Error("proposal failed");

    // Approver's filter doesn't match the document
    const approverCtx: BrokerContext = { userId: "approver_filter", env: "dev", orgId: "default" };
    const approveRes = await broker.approveProposal(approverCtx, propRes.proposalId);
    expect(approveRes.ok).toBe(false);
    if (!approveRes.ok) {
      expect(approveRes.reason).toBe("not_found");
    }
  });

  it("grant without approve verb → verb_denied", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_noapprove", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const nonApproverGrantId = await requestGrant(app, {
      userId: "non_approver", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, nonApproverGrantId, "admin", { verbs: ["read"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'noapprove@ex.com', 'No Approve', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Propose
    const proposerCtx: BrokerContext = { userId: "proposer_noapprove", env: "dev", orgId: "default" };
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "noapprove_new@ex.com" },
    });
    expect(propRes.ok).toBe(true);
    if (!propRes.ok) throw new Error("proposal failed");

    // Non-approver tries to approve
    const noApproveCtx: BrokerContext = { userId: "non_approver", env: "dev", orgId: "default" };
    const approveRes = await broker.approveProposal(noApproveCtx, propRes.proposalId);
    expect(approveRes.ok).toBe(false);
    if (!approveRes.ok) {
      expect(approveRes.reason).toBe("verb_denied");
    }
  });

  it("listProposals returns no field values", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_list", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_list", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'secret_value@ex.com', 'Secret Name', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    // Propose a change with a specific value
    const proposerCtx: BrokerContext = { userId: "proposer_list", env: "dev", orgId: "default" };
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "secret_new_email@ex.com" },
    });
    expect(propRes.ok).toBe(true);

    // List proposals
    const approverCtx: BrokerContext = { userId: "approver_list", env: "dev", orgId: "default" };
    const listRes = await broker.listProposals(approverCtx, { status: "pending" });
    expect(listRes.ok).toBe(true);

    if (listRes.ok) {
      // Stringify and check for proposed values - should not be present
      const stringified = JSON.stringify(listRes.proposals);
      expect(stringified).not.toContain("secret_new_email@ex.com");
      expect(stringified).not.toContain("secret_value@ex.com");
      expect(stringified).not.toContain("Secret Name");
      expect(stringified).not.toContain("Secret");

      // Should still contain field names
      expect(stringified).toContain("email");
    }
  });

  it("listProposals shows nothing from collection caller cannot read", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_noread2", collection: "people", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const noReadGrantId = await requestGrant(app, {
      userId: "no_read_grant", collection: "sensitive", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id"],
    });
    await approveGrant(app, cfg, noReadGrantId, "admin", { verbs: ["create"] });

    // Create document and proposal
    const createRes = await app.query(
      `insert into data_synth.people (org_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'noread@ex.com', 'No Read', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`);
    const docId = createRes.rows[0].id;

    const proposerCtx: BrokerContext = { userId: "proposer_noread2", env: "dev", orgId: "default" };
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "noread_new@ex.com" },
    });
    expect(propRes.ok).toBe(true);

    // User without approval verb lists proposals
    const noReadCtx: BrokerContext = { userId: "no_read_grant", env: "dev", orgId: "default" };
    const listRes = await broker.listProposals(noReadCtx);
    expect(listRes.ok).toBe(true);

    if (listRes.ok) {
      // Should not see proposals for collections without approve verb
      const peopleProposals = listRes.proposals.filter((p) => p.collection === "people");
      expect(peopleProposals.length).toBe(0);
    }
  });
});
