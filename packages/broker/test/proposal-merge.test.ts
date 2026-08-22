import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { assertPending } from "./helpers/results";
import { mergeRevision, checkFourEyes } from "../src/verbs/propose";

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

describe("broker.approveProposal merge logic", () => {
  it("two disjoint field proposals both approve cleanly, final doc carries both", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_disjoint",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_disjoint",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document with initial values
    const createRes = await app.query(
      `insert into data_synth.people (workspace_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'test@ex.com', 'Test', 'Engineering', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`,
    );
    const docId = createRes.rows[0].id;

    // Proposal 1: update email
    const proposerCtx: BrokerContext = makeCtx({ userId: "proposer_disjoint" });
    const prop1Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "email1@ex.com" },
    });
    expect(prop1Res.ok).toBe(true);
    assertPending(prop1Res);
    const prop1Id = prop1Res.proposalId;

    // Proposal 2: update name (different field)
    const prop2Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { name: "Updated Name" },
    });
    expect(prop2Res.ok).toBe(true);
    assertPending(prop2Res);
    const prop2Id = prop2Res.proposalId;

    // Approve both
    const approverCtx: BrokerContext = makeCtx({ userId: "approver_disjoint" });
    const approve1Res = await broker.approveProposal(approverCtx, prop1Id);
    expect(approve1Res.ok).toBe(true);

    const approve2Res = await broker.approveProposal(approverCtx, prop2Id);
    expect(approve2Res.ok).toBe(true);

    // Verify final document has both changes
    const queryResult = await broker.query(proposerCtx, {
      collection: "people",
      fields: ["id", "email", "name"],
    });
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
      userId: "proposer_overlap",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_overlap",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (workspace_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'overlap@ex.com', 'Overlap', 'Sales', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`,
    );
    const docId = createRes.rows[0].id;

    // Proposal 1: update email
    const proposerCtx: BrokerContext = makeCtx({ userId: "proposer_overlap" });
    const prop1Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "email_overlap1@ex.com" },
    });
    expect(prop1Res.ok).toBe(true);
    assertPending(prop1Res);
    const prop1Id = prop1Res.proposalId;

    // Proposal 2: also update email (overlapping field)
    const prop2Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "email_overlap2@ex.com" },
    });
    expect(prop2Res.ok).toBe(true);
    assertPending(prop2Res);
    const prop2Id = prop2Res.proposalId;

    // Approve first
    const approverCtx: BrokerContext = makeCtx({ userId: "approver_overlap" });
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
      userId: "proposer_stale",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const directGrantId = await requestGrant(app, {
      userId: "direct_update",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, directGrantId, "admin", { verbs: ["read", "update"] });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_stale",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (workspace_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'stale@ex.com', 'Stale', 'HR', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`,
    );
    const docId = createRes.rows[0].id;

    // Proposal: update email (based on rev_seq 1)
    const proposerCtx: BrokerContext = makeCtx({ userId: "proposer_stale" });
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "proposal_email@ex.com" },
    });
    expect(propRes.ok).toBe(true);
    assertPending(propRes);
    const propId = propRes.proposalId;

    // Make a direct update to the same field (email) - this advances _rev_seq to 2
    const directCtx: BrokerContext = makeCtx({ userId: "direct_update" });
    const directRes = await broker.mutate(directCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "direct_email@ex.com" },
    });
    expect(directRes.ok).toBe(true);

    // Try to approve the stale proposal with overlapping field → should fail
    const approverCtx: BrokerContext = makeCtx({ userId: "approver_stale" });
    const approveRes = await broker.approveProposal(approverCtx, propId);
    expect(approveRes.ok).toBe(false);
    if (!approveRes.ok) {
      expect(approveRes.reason).toBe("conflict");
    }
  });

  it("stale base with no overlap promotes", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_stale_ok",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const directGrantId = await requestGrant(app, {
      userId: "direct_update2",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, directGrantId, "admin", { verbs: ["read", "update"] });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_stale_ok",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name", "dept"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (workspace_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'stale_ok@ex.com', 'Stale OK', 'Finance', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`,
    );
    const docId = createRes.rows[0].id;

    // Proposal: update name (based on rev_seq 1)
    const proposerCtx: BrokerContext = makeCtx({ userId: "proposer_stale_ok" });
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { name: "Proposal Name" },
    });
    expect(propRes.ok).toBe(true);
    assertPending(propRes);
    const propId = propRes.proposalId;

    // Make a direct update to a different field (email) - this advances _rev_seq to 2
    const directCtx: BrokerContext = makeCtx({ userId: "direct_update2" });
    const directRes = await broker.mutate(directCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "new_email@ex.com" },
    });
    expect(directRes.ok).toBe(true);

    // Approve the stale proposal with no overlapping field → should succeed
    const approverCtx: BrokerContext = makeCtx({ userId: "approver_stale_ok" });
    const approveRes = await broker.approveProposal(approverCtx, propId);
    expect(approveRes.ok).toBe(true);

    // Verify final document has both changes
    const queryResult = await broker.query(proposerCtx, {
      collection: "people",
      fields: ["id", "email", "name"],
    });
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
      userId: "proposer_rev_by",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_rev_by",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (workspace_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'rev_by@ex.com', 'Rev By', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`,
    );
    const docId = createRes.rows[0].id;

    // Propose
    const proposerCtx: BrokerContext = makeCtx({ userId: "proposer_rev_by" });
    const propRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "new_rev_by@ex.com" },
    });
    expect(propRes.ok).toBe(true);
    assertPending(propRes);
    const propId = propRes.proposalId;

    // Approve
    const approverCtx: BrokerContext = makeCtx({ userId: "approver_rev_by" });
    const approveRes = await broker.approveProposal(approverCtx, propId);
    expect(approveRes.ok).toBe(true);
    if (!approveRes.ok) throw new Error("approval failed");

    // Check that _rev_by is the proposer, not the approver
    const row = await app.query(
      `select _rev_by, _rev from data_synth.people where id = $1 and _current`,
      [docId],
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0]._rev_by).toBe("proposer_rev_by");
  });

  it("_rev_seq is strictly increasing per document", async () => {
    const proposerGrantId = await requestGrant(app, {
      userId: "proposer_seq",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, proposerGrantId, "admin", {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });

    const approverGrantId = await requestGrant(app, {
      userId: "approver_seq",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: ["id", "email", "name"],
    });
    await approveGrant(app, cfg, approverGrantId, "admin", { verbs: ["read", "approve"] });

    // Create document
    const createRes = await app.query(
      `insert into data_synth.people (workspace_id, id, email, name, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'seq@ex.com', 'Seq', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`,
    );
    const docId = createRes.rows[0].id;

    const proposerCtx: BrokerContext = makeCtx({ userId: "proposer_seq" });
    const approverCtx: BrokerContext = makeCtx({ userId: "approver_seq" });

    // Proposal 1
    const prop1Res = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: docId,
      values: { email: "seq1@ex.com" },
    });
    expect(prop1Res.ok).toBe(true);
    assertPending(prop1Res);
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
    assertPending(prop2Res);
    const approve2Res = await broker.approveProposal(approverCtx, prop2Res.proposalId);
    expect(approve2Res.ok).toBe(true);

    // The sequence is a property of the document's history — the states it actually held — so it
    // is asserted over the non-superseded rows.
    //
    // This used to select every row and pass because the duplicates happened to be consecutive:
    // an approval inserted a merged row at max(_rev_seq)+1 *and* flipped the pending row to
    // approved, yielding 1,2,3,4,5 for a document with three real revisions. Excluding superseded
    // rows now gives 1,2,3, and a superseded proposal deliberately shares the seq of the revision
    // that consumed it — it was an attempt at that seq.
    const rows = await app.query(
      `select _rev_seq, _rev_status from data_synth.people
       where id = $1 and _rev_status <> 'superseded' order by _rev_seq`,
      [docId],
    );
    expect(rows.rows.length).toBe(3); // seeded create + two approved updates
    expect(rows.rows.map((r) => Number(r._rev_seq))).toEqual([1, 2, 3]);
    // No gaps and no repeats, stated directly rather than inferred from a pairwise walk.
    expect(rows.rows.some((r) => r._rev_status === "superseded")).toBe(false);
  });
});

// Approving used to leave two rows in the table for one revision: the merged row it inserts, and
// the pending row flipped to `approved`. Both carried the same _rev_fields and _rev_by, so a
// document's history showed every approval twice — and because the merged row's seq came from
// max(_rev_seq), which counted the pending row, the sequence skipped a number each time.
describe("approval writes one revision, not two", () => {
  // A full propose → approve cycle through the broker, so the row layout under test is the one the
  // real path produces rather than a hand-written fixture.
  async function cycle(suffix: string) {
    const users = { proposer: `merge_prop_${suffix}`, approver: `merge_appr_${suffix}` };
    for (const [role, userId] of Object.entries(users)) {
      const g = await requestGrant(app, {
        userId,
        collection: "people",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "test",
        allowedFields: ["id", "email", "name", "dept"],
      });
      await approveGrant(app, cfg, g, "admin", {
        verbs: ["read", "create", "update", "approve"],
        mode: role === "proposer" ? "proposal_only" : "direct",
      });
    }
    const prop: BrokerContext = makeCtx({ userId: users.proposer });
    const appr: BrokerContext = makeCtx({ userId: users.approver });

    const created = await broker.mutate(prop, {
      collection: "people",
      op: "create",
      values: { email: `${suffix}@ex.com`, name: "N", dept: "D" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok || created.status !== "pending") throw new Error("expected a pending create");
    const a1 = await broker.approveProposal(appr, created.proposalId);
    expect(a1.ok, JSON.stringify(a1)).toBe(true);
    if (!a1.ok) throw new Error("approve failed");
    const id = a1.documentId;

    const updated = await broker.mutate(prop, {
      collection: "people",
      op: "update",
      id,
      values: { name: "N2" },
    });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    if (!updated.ok || updated.status !== "pending") throw new Error("expected a pending update");
    const a2 = await broker.approveProposal(appr, updated.proposalId);
    expect(a2.ok, JSON.stringify(a2)).toBe(true);

    return { id, prop, appr };
  }

  it("reports one revision per approval, with a contiguous sequence", async () => {
    const { id, appr } = await cycle("hist");
    const revs = await broker.listRevisions(appr, { collection: "people", id });
    expect(revs.ok).toBe(true);
    if (!revs.ok) return;
    // Two approvals — a create and an update — so two revisions. This returned four.
    expect(revs.revisions.map((r) => ({ seq: r.seq, op: r.op }))).toEqual([
      { seq: 1, op: "create" },
      { seq: 2, op: "update" },
    ]);
    // Sequence numbers used to run 1, 1, 2, 3: max(_rev_seq) counted the pending row, and the
    // create case pinned the merged row at 1 alongside it.
    expect(new Set(revs.revisions.map((r) => r.seq)).size).toBe(revs.revisions.length);
  });

  it("keeps the consumed proposal row, marked superseded rather than approved", async () => {
    const { id } = await cycle("keep");
    const rows = await app.query(
      `select _rev_seq, _rev_status, _current from data_synth.people
       where id = $1 order by _rev_seq, _rev_status`,
      [id],
    );
    // The row is retained deliberately: it records what was *proposed*, which the merged row does
    // not preserve once a merge pulled in a concurrent change. The write role holds no DELETE.
    const superseded = rows.rows.filter((r) => r._rev_status === "superseded");
    expect(superseded.length).toBe(2);
    // It must never be the current revision, or a read would serve the proposal as the document.
    expect(superseded.every((r) => r._current === false)).toBe(true);
    expect(rows.rows.filter((r) => r._rev_status === "approved" && r._current).length).toBe(1);
  });

  it("does not let a superseded row reach the read path", async () => {
    const { id, appr } = await cycle("read");
    const q = await broker.query(appr, { collection: "people", fields: ["id", "name"] });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const mine = q.documents.filter((d) => d.id === id);
    // One document, holding the approved update — not two, and not the pre-update value.
    expect(mine.length).toBe(1);
    expect(mine[0]!.name).toBe("N2");
  });

  it("lists an approved proposal once, under the status the caller asked for", async () => {
    const { id, appr } = await cycle("list");
    // `superseded` is a storage detail; a caller asks about the proposal lifecycle. Asking the
    // table directly for 'approved' would return the merged revisions instead — and before the
    // statuses were separated it matched both rows, so this listing was doubled.
    //
    // Scoped to this test's document: the collection is shared with every other test in the file,
    // and listProposals is collection-wide by design.
    const approved = await broker.listProposals(appr, { collection: "people", status: "approved" });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const mine = approved.proposals.filter((p) => p.documentId === id);
    expect(mine.length).toBe(2); // the create and the update
    expect(new Set(mine.map((p) => p.proposalId)).size).toBe(2); // distinct, not the same row twice

    const pending = await broker.listProposals(appr, { collection: "people", status: "pending" });
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(pending.proposals.filter((p) => p.documentId === id)).toEqual([]);
  });

  it("still merges a stale base with no overlap, which is the reason a merged row exists", async () => {
    // Guards the documented rule this whole design has to preserve: architecture.md states
    // "Staleness alone is not a conflict — overlap is." If that ever became a conflict, the merged
    // insert could be replaced by promoting the pending row in place — and this test is what would
    // have to change first, deliberately.
    const { id, prop, appr } = await cycle("stale");
    // Propose against the current state, then move a *different* field underneath it.
    const stale = await broker.mutate(prop, {
      collection: "people",
      op: "update",
      id,
      values: { dept: "D2" },
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok || stale.status !== "pending") return;
    const direct = await broker.mutate(appr, {
      collection: "people",
      op: "update",
      id,
      values: { email: "moved@ex.com" },
    });
    expect(direct.ok, JSON.stringify(direct)).toBe(true);

    const approved = await broker.approveProposal(appr, stale.proposalId);
    expect(approved.ok, JSON.stringify(approved)).toBe(true);

    const q = await broker.query(appr, { collection: "people", fields: ["id", "dept", "email"] });
    if (!q.ok) throw new Error("query failed");
    const doc = q.documents.find((d) => d.id === id)!;
    // Both survive: the proposal's field and the concurrent change it did not touch.
    expect(doc.dept).toBe("D2");
    expect(doc.email).toBe("moved@ex.com");
  });
});

// §C. The merge rule and the four-eyes rule are the two parts of approval worth checking without
// a transaction, and extracting them is what makes that possible: as inline blocks inside a
// 200-line `approveProposal` neither could be reached except by running a full approval.
describe("mergeRevision", () => {
  const c = cfg.collections.people!;

  it("lays the proposal's own changed fields over the current revision", () => {
    const current = {
      _rev: "r1",
      _rev_seq: 3,
      _rev_op: "update",
      _rev_by: "a",
      _rev_base: null,
      id: "doc-1",
      email: "old@ex.com",
      name: "Old Name",
      dept: "Legal",
    } as unknown as Parameters<typeof mergeRevision>[2];
    const proposal = {
      _rev: "r2",
      _rev_seq: 4,
      _rev_op: "update",
      _rev_by: "b",
      _rev_base: 3,
      _rev_fields: ["email"],
      id: "doc-1",
      email: "new@ex.com",
      name: "Stale Name",
      dept: "Stale Dept",
    } as unknown as Parameters<typeof mergeRevision>[1];

    const { merged, newSeq } = mergeRevision(c, proposal, current);
    expect(merged.email).toBe("new@ex.com");
    // Untouched fields keep whatever they acquired while the proposal was pending — the
    // proposal's stale copy of them is not a change it asked for.
    expect(merged.name).toBe("Old Name");
    expect(merged.dept).toBe("Legal");
    // Contiguous with the revision being replaced, not max(_rev_seq).
    expect(newSeq).toBe(4);
  });

  it("takes a create's values wholesale and starts the sequence at 1", () => {
    const proposal = {
      _rev: "r1",
      _rev_op: "create",
      _rev_by: "b",
      _rev_base: null,
      _rev_fields: ["id", "email"],
      id: "doc-2",
      email: "new@ex.com",
      name: null,
      dept: null,
    } as unknown as Parameters<typeof mergeRevision>[1];
    const { merged, newSeq } = mergeRevision(c, proposal, null);
    expect(merged.id).toBe("doc-2");
    expect(merged.email).toBe("new@ex.com");
    expect(newSeq).toBe(1);
  });
});

describe("checkFourEyes", () => {
  it("is true when the approver is the proposer", () => {
    expect(checkFourEyes({ _rev_by: "alice" }, { userId: "alice" })).toBe(true);
  });
  it("is false for anybody else", () => {
    expect(checkFourEyes({ _rev_by: "alice" }, { userId: "bob" })).toBe(false);
  });
});
