import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
import type { WarehousdConfig, CollectionConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import type { ActiveGrant } from "../src/grants/eval";
import type { RevisionRow } from "../src/config/collection";
import { makeCtx } from "./helpers/ctx";
import { assertPending } from "./helpers/results";
import { authorizeDecision } from "../src/verbs/propose";

// Atomic batch decisions (Phase 1, P0-1): a list of approve/reject calls that commit or roll back
// together, audited one row per input decision either way. Model is proposals.test.ts and
// proposal-decision-refusals.test.ts; this file is about the BATCH shape those files never touch.

let p: Provisioned, app: Pool, pools: any;

const PEOPLE_FIELDS = ["id", "email", "name", "dept"];
const TASK_FIELDS = ["id", "title", "status"];

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
    tasks: {
      description: "Tasks",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
        status: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("proposal-batch");
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

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

async function grantOn(
  userId: string,
  collection: string,
  fields: string[],
  opts: {
    verbs?: string[];
    mode?: "direct" | "proposal_only";
    documentFilters?: { field: string; op: string; value: unknown }[];
  } = {},
) {
  const id = await requestGrant(app, {
    userId,
    collection,
    env: "dev",
    workspaceId: "default",
    purposeLabel: "test",
    allowedFields: fields,
  });
  await approveGrant(app, cfg, id, "admin", {
    verbs: opts.verbs ?? ["read", "approve"],
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.documentFilters ? { documentFilters: opts.documentFilters as never } : {}),
  });
  return id;
}

async function seedPerson(dept: string, email = `${uniq("seed")}@ex.com`): Promise<string> {
  const r = await app.query(
    `insert into data_synth.people (workspace_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
     values ('default', gen_random_uuid(), $1, 'Seed', $2, gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
     returning id`,
    [email, dept],
  );
  return r.rows[0].id as string;
}

async function proposeEmailUpdate(
  proposerCtx: BrokerContext,
  docId: string,
  email: string,
): Promise<string> {
  const res = await broker.mutate(proposerCtx, {
    collection: "people",
    op: "update",
    id: docId,
    values: { email },
  });
  assertPending(res);
  return res.proposalId;
}

async function proposeCreate(
  proposerCtx: BrokerContext,
  values: Record<string, unknown>,
): Promise<string> {
  const res = await broker.mutate(proposerCtx, { collection: "people", op: "create", values });
  assertPending(res);
  return res.proposalId;
}

async function auditRowsFor(batchId: string) {
  const r = await app.query(
    `select collection, reason, outcome, batch_id from app.audit_events where batch_id = $1`,
    [batchId],
  );
  return r.rows as {
    collection: string | null;
    reason: string | null;
    outcome: string;
    batch_id: string;
  }[];
}

describe("decideProposals: a committed batch", () => {
  it("3 approves + 1 reject commit together, one batch_id shared across four audit rows", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(approver, "people", PEOPLE_FIELDS);

    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const docs = await Promise.all([
      seedPerson("Engineering"),
      seedPerson("Engineering"),
      seedPerson("Engineering"),
      seedPerson("Engineering"),
    ]);
    const proposals = await Promise.all(
      docs.map((id, i) => proposeEmailUpdate(proposerCtx, id, `new${i}@ex.com`)),
    );

    const result = await broker.decideProposals(approverCtx, {
      decisions: [
        { proposalId: proposals[0]!, action: "approve" },
        { proposalId: proposals[1]!, action: "approve" },
        { proposalId: proposals[2]!, action: "approve" },
        { proposalId: proposals[3]!, action: "reject" },
      ],
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.decisions.length).toBe(4);
    expect(result.decisions.every((d) => d.ok)).toBe(true);

    const rows = await app.query(
      `select id, email from data_synth.people where id = any($1) and _current`,
      [docs],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.email]));
    expect(byId.get(docs[0])).toBe("new0@ex.com");
    expect(byId.get(docs[1])).toBe("new1@ex.com");
    expect(byId.get(docs[2])).toBe("new2@ex.com");
    // Rejected: the proposal is marked rejected, and the document's own current row is unchanged.
    const rejectedRow = await app.query(
      `select _rev_status from data_synth.people where _rev = $1`,
      [proposals[3]],
    );
    expect(rejectedRow.rows[0]!._rev_status).toBe("rejected");
    expect(byId.get(docs[3])).not.toMatch(/^new/);

    const auditRows = await app.query(
      `select count(distinct batch_id) as batches, count(*) as rows from app.audit_events where batch_id = $1`,
      [result.batchId],
    );
    expect(Number(auditRows.rows[0].batches)).toBe(1);
    expect(Number(auditRows.rows[0].rows)).toBe(4);
  });
});

describe("decideProposals: atomicity", () => {
  it("a batch whose third item fails four-eyes leaves the store byte-identical", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    // The approver also holds a proposal_only grant so their OWN update lands pending — the
    // proposal item three below is theirs, which is what makes it fail four eyes.
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(approver, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update", "approve"],
      mode: "proposal_only",
    });

    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const docs = await Promise.all([
      seedPerson("Engineering"),
      seedPerson("Engineering"),
      seedPerson("Engineering"),
      seedPerson("Engineering"),
    ]);
    const item1 = await proposeEmailUpdate(proposerCtx, docs[0], "abort1@ex.com");
    const item2 = await proposeEmailUpdate(proposerCtx, docs[1], "abort2@ex.com");
    const item3 = await proposeEmailUpdate(approverCtx, docs[2], "abort3@ex.com"); // self-proposed
    const item4 = await proposeEmailUpdate(proposerCtx, docs[3], "abort4@ex.com");

    const before = await app.query(`select * from data_synth.people order by id, _rev`);
    const beforeLog = await app.query(`select * from app.change_log order by seq`);

    const result = await broker.decideProposals(approverCtx, {
      decisions: [
        { proposalId: item1, action: "approve" },
        { proposalId: item2, action: "approve" },
        { proposalId: item3, action: "approve" },
        { proposalId: item4, action: "reject" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("self_approval_denied");
    expect(result.failedProposalId).toBe(item3);

    const after = await app.query(`select * from data_synth.people order by id, _rev`);
    const afterLog = await app.query(`select * from app.change_log order by seq`);
    // Byte-identical: not merely that _rev_status is unchanged, the whole row set.
    expect(after.rows).toEqual(before.rows);
    expect(afterLog.rows).toEqual(beforeLog.rows);

    // Prove the test has teeth: re-run against pre-change behaviour is done manually (see report);
    // here we additionally pin that every proposal is still pending.
    const stillPending = await app.query(
      `select _rev_status from data_synth.people where _rev = any($1)`,
      [[item1, item2, item3, item4]],
    );
    expect(stillPending.rows.every((r) => r._rev_status === "pending")).toBe(true);
  });

  it("writes four audit rows sharing one batch_id: the failing item named, the rest batch_aborted", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(approver, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update", "approve"],
      mode: "proposal_only",
    });

    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const docs = await Promise.all([
      seedPerson("Engineering"),
      seedPerson("Engineering"),
      seedPerson("Engineering"),
      seedPerson("Engineering"),
    ]);
    const item1 = await proposeEmailUpdate(proposerCtx, docs[0], "x1@ex.com");
    const item2 = await proposeEmailUpdate(proposerCtx, docs[1], "x2@ex.com");
    const item3 = await proposeEmailUpdate(approverCtx, docs[2], "x3@ex.com");
    const item4 = await proposeEmailUpdate(proposerCtx, docs[3], "x4@ex.com");

    const result = await broker.decideProposals(approverCtx, {
      decisions: [
        { proposalId: item1, action: "approve" },
        { proposalId: item2, action: "approve" },
        { proposalId: item3, action: "approve" },
        { proposalId: item4, action: "reject" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const rows = await auditRowsFor(result.batchId);
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.outcome === "refused")).toBe(true);
    expect(rows.filter((r) => r.reason === "self_approval_denied").length).toBe(1);
    expect(rows.filter((r) => r.reason === "batch_aborted").length).toBe(3);
    expect(new Set(rows.map((r) => r.batch_id)).size).toBe(1);
  });
});

describe("decideProposals: batching is a transaction boundary, never a permission shortcut", () => {
  it("fails the whole batch with verb_denied when one proposal is on a collection the approver cannot approve", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(proposer, "tasks", TASK_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(approver, "people", PEOPLE_FIELDS); // read + approve
    // A real grant, but without the approve verb — verb_denied, not no_grant.
    await grantOn(approver, "tasks", TASK_FIELDS, { verbs: ["read"] });

    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const personDoc = await seedPerson("Engineering");
    const taskRow = await app.query(
      `insert into data_synth.tasks (workspace_id, id, title, status, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'T', 'open', gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
       returning id`,
    );
    const taskId = taskRow.rows[0].id as string;

    const peopleProposal = await proposeEmailUpdate(proposerCtx, personDoc, "vd@ex.com");
    const taskProposalRes = await broker.mutate(proposerCtx, {
      collection: "tasks",
      op: "update",
      id: taskId,
      values: { status: "closed" },
    });
    assertPending(taskProposalRes);

    const result = await broker.decideProposals(approverCtx, {
      decisions: [
        { proposalId: peopleProposal, action: "approve" },
        { proposalId: taskProposalRes.proposalId, action: "approve" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("verb_denied");
    expect(result.failedProposalId).toBe(taskProposalRes.proposalId);

    const person = await app.query(`select email from data_synth.people where id=$1 and _current`, [
      personDoc,
    ]);
    expect(person.rows[0].email).not.toBe("vd@ex.com");
  });

  it("fails the whole batch with field_denied when one proposal touches a field outside the approver's allowedFields", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    // Approver cannot read "dept" — the privilege-escalation guard, now on the batch path.
    await grantOn(approver, "people", ["id", "email", "name"]);

    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const doc1 = await seedPerson("Engineering");
    const doc2 = await seedPerson("Engineering");
    const fineProposal = await proposeEmailUpdate(proposerCtx, doc1, "fine@ex.com");
    const deptRes = await broker.mutate(proposerCtx, {
      collection: "people",
      op: "update",
      id: doc2,
      values: { dept: "Sales" },
    });
    assertPending(deptRes);

    const result = await broker.decideProposals(approverCtx, {
      decisions: [
        { proposalId: fineProposal, action: "approve" },
        { proposalId: deptRes.proposalId, action: "approve" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("field_denied");
    expect(result.failedProposalId).toBe(deptRes.proposalId);
  });

  it("fails the whole batch with not_found when a document filter/ACL excludes one proposal", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(approver, "people", PEOPLE_FIELDS, {
      documentFilters: [{ field: "dept", op: "eq", value: "Engineering" }],
    });

    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const visible = await seedPerson("Engineering");
    const hidden = await seedPerson("Sales");
    const visibleProposal = await proposeEmailUpdate(proposerCtx, visible, "v@ex.com");
    const hiddenProposal = await proposeEmailUpdate(proposerCtx, hidden, "h@ex.com");

    const result = await broker.decideProposals(approverCtx, {
      decisions: [
        { proposalId: visibleProposal, action: "approve" },
        { proposalId: hiddenProposal, action: "approve" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
    expect(result.failedProposalId).toBe(hiddenProposal);

    const stillPending = await app.query(
      `select _rev_status from data_synth.people where _rev=$1`,
      [visibleProposal],
    );
    expect(stillPending.rows[0]._rev_status).toBe("pending");
  });

  it("writes one audit row per input decision when the FIRST item is the one that aborts", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(approver, "people", PEOPLE_FIELDS);

    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const fakeId = "00000000-0000-0000-0000-000000000099"; // not_found — fails on the first item
    const doc2 = await seedPerson("Engineering");
    const doc3 = await seedPerson("Engineering");
    const prop2 = await proposeEmailUpdate(proposerCtx, doc2, "first1@ex.com");
    const prop3 = await proposeEmailUpdate(proposerCtx, doc3, "first2@ex.com");

    const result = await broker.decideProposals(approverCtx, {
      decisions: [
        { proposalId: fakeId, action: "approve" },
        { proposalId: prop2, action: "approve" },
        { proposalId: prop3, action: "approve" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
    expect(result.failedProposalId).toBe(fakeId);

    const rows = await auditRowsFor(result.batchId);
    expect(rows.length).toBe(3);
    expect(rows.filter((r) => r.reason === "not_found").length).toBe(1);
    expect(rows.filter((r) => r.reason === "batch_aborted").length).toBe(2);
  });
});

describe("decideProposals: envelope refusals", () => {
  it("duplicate proposalId -> invalid_intent, nothing written, one audit row", async () => {
    const approver = uniq("approver");
    await grantOn(approver, "people", PEOPLE_FIELDS);
    const approverCtx = makeCtx({ userId: approver });

    const fakeId = "00000000-0000-0000-0000-000000000000";
    const result = await broker.decideProposals(approverCtx, {
      decisions: [
        { proposalId: fakeId, action: "approve" },
        { proposalId: fakeId, action: "reject" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_intent");
    expect(result.decisions).toEqual([]);

    const rows = await auditRowsFor(result.batchId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.collection).toBe("*");
  });

  it("MAX_BATCH_DECISIONS + 1 items -> invalid_intent, nothing written", async () => {
    const approver = uniq("approver");
    await grantOn(approver, "people", PEOPLE_FIELDS);
    const approverCtx = makeCtx({ userId: approver });

    const decisions = Array.from({ length: 101 }, (_, i) => ({
      proposalId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      action: "approve" as const,
    }));
    const result = await broker.decideProposals(approverCtx, { decisions });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_intent");
    expect(result.decisions).toEqual([]);

    const rows = await auditRowsFor(result.batchId);
    expect(rows.length).toBe(1);
  });
});

describe("decideProposals: parity with the single-item wrappers", () => {
  it("approveProposal matches a direct one-item decideProposals call on success", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(approver, "people", PEOPLE_FIELDS);
    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const docA = await seedPerson("Engineering");
    const docB = await seedPerson("Engineering");
    const propA = await proposeEmailUpdate(proposerCtx, docA, "a@ex.com");
    const propB = await proposeEmailUpdate(proposerCtx, docB, "b@ex.com");

    const viaWrapper = await broker.approveProposal(approverCtx, propA);
    const viaBatch = await broker.decideProposals(approverCtx, {
      decisions: [{ proposalId: propB, action: "approve" }],
    });

    expect(viaWrapper.ok).toBe(true);
    expect(viaBatch.ok).toBe(true);
    if (!viaWrapper.ok || !viaBatch.ok) return;
    const batchOutcome = viaBatch.decisions[0]!;
    expect(batchOutcome.ok).toBe(true);
    if (!batchOutcome.ok) return;
    expect(viaWrapper.documentId).toBe(docA);
    expect(batchOutcome.documentId).toBe(docB);
    // Same shape: both an applied documentId+rev+auditId, no batch_aborted involved.
    expect(typeof viaWrapper.rev).toBe("string");
    expect(typeof batchOutcome.rev).toBe("string");
  });

  it("approveProposal matches a direct one-item decideProposals call on not_found", async () => {
    const approver = uniq("approver");
    await grantOn(approver, "people", PEOPLE_FIELDS);
    const approverCtx = makeCtx({ userId: approver });
    const fakeId = "00000000-0000-0000-0000-000000000001";

    const viaWrapper = await broker.approveProposal(approverCtx, fakeId);
    const viaBatch = await broker.decideProposals(approverCtx, {
      decisions: [{ proposalId: fakeId, action: "approve" }],
    });

    expect(viaWrapper.ok).toBe(false);
    if (viaWrapper.ok) return;
    expect(viaWrapper.reason).toBe("not_found");
    expect(viaBatch.ok).toBe(false);
    if (viaBatch.ok) return;
    expect(viaBatch.reason).toBe("not_found");
    expect(viaBatch.failedProposalId).toBe(fakeId);
  });

  it("approveProposal matches a direct one-item decideProposals call on self_approval_denied", async () => {
    const selfId = uniq("self");
    await grantOn(selfId, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update", "approve"],
      mode: "proposal_only",
    });
    const selfCtx = makeCtx({ userId: selfId });

    const doc1 = await seedPerson("Engineering");
    const doc2 = await seedPerson("Engineering");
    const prop1 = await proposeEmailUpdate(selfCtx, doc1, "s1@ex.com");
    const prop2 = await proposeEmailUpdate(selfCtx, doc2, "s2@ex.com");

    const viaWrapper = await broker.approveProposal(selfCtx, prop1);
    const viaBatch = await broker.decideProposals(selfCtx, {
      decisions: [{ proposalId: prop2, action: "approve" }],
    });

    expect(viaWrapper.ok).toBe(false);
    if (viaWrapper.ok) return;
    expect(viaWrapper.reason).toBe("self_approval_denied");
    expect(viaBatch.ok).toBe(false);
    if (viaBatch.ok) return;
    expect(viaBatch.reason).toBe("self_approval_denied");
  });

  it("approveProposal matches a direct one-item decideProposals call on verb_denied", async () => {
    const proposer = uniq("proposer");
    const noApprove = uniq("noapprove");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(noApprove, "people", PEOPLE_FIELDS, { verbs: ["read"] });
    const proposerCtx = makeCtx({ userId: proposer });
    const noApproveCtx = makeCtx({ userId: noApprove });

    const doc1 = await seedPerson("Engineering");
    const doc2 = await seedPerson("Engineering");
    const prop1 = await proposeEmailUpdate(proposerCtx, doc1, "v1@ex.com");
    const prop2 = await proposeEmailUpdate(proposerCtx, doc2, "v2@ex.com");

    const viaWrapper = await broker.approveProposal(noApproveCtx, prop1);
    const viaBatch = await broker.decideProposals(noApproveCtx, {
      decisions: [{ proposalId: prop2, action: "approve" }],
    });

    expect(viaWrapper.ok).toBe(false);
    if (viaWrapper.ok) return;
    expect(viaWrapper.reason).toBe("verb_denied");
    expect(viaBatch.ok).toBe(false);
    if (viaBatch.ok) return;
    expect(viaBatch.reason).toBe("verb_denied");
  });
});

describe("decideProposals: cost", () => {
  it("a 40-proposal batch across 2 collections issues one loadActiveGrants call", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "create"],
      mode: "proposal_only",
    });
    await grantOn(proposer, "tasks", TASK_FIELDS, {
      verbs: ["read", "create"],
      mode: "proposal_only",
    });
    await grantOn(approver, "people", PEOPLE_FIELDS);
    await grantOn(approver, "tasks", TASK_FIELDS);

    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const peopleProposals = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        proposeCreate(proposerCtx, { email: `cost${i}@ex.com`, name: "N", dept: "D" }),
      ),
    );
    const taskProposals = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const res = await broker.mutate(proposerCtx, {
          collection: "tasks",
          op: "create",
          values: { title: `T${i}`, status: "open" },
        });
        assertPending(res);
        return res.proposalId;
      }),
    );

    let grantQueries = 0;
    const countingApp = new Proxy(pools.app, {
      get(target: Pool, prop: string | symbol, receiver: unknown) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (text: unknown, ...rest: unknown[]) => {
          if (typeof text === "string" && text.includes("app.grants")) grantQueries += 1;
          return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
        };
      },
    });
    const countingBroker = makeBroker({ ...pools, app: countingApp }, cfg);

    const decisions = [...peopleProposals, ...taskProposals].map((proposalId) => ({
      proposalId,
      action: "approve" as const,
    }));
    const result = await countingBroker.decideProposals(approverCtx, { decisions });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(grantQueries).toBe(1);
  });
});

describe("decideProposals: an allow whose audit write fails downgrades to a refusal", () => {
  it("forces internal_error, commits nothing, and still writes the refusal rows", async () => {
    const proposer = uniq("proposer");
    const approver = uniq("approver");
    await grantOn(proposer, "people", PEOPLE_FIELDS, {
      verbs: ["read", "update"],
      mode: "proposal_only",
    });
    await grantOn(approver, "people", PEOPLE_FIELDS);
    const proposerCtx = makeCtx({ userId: proposer });
    const approverCtx = makeCtx({ userId: approver });

    const docs = await Promise.all([
      seedPerson("Engineering"),
      seedPerson("Engineering"),
      seedPerson("Engineering"),
      seedPerson("Engineering"),
    ]);
    const proposals = await Promise.all(
      docs.map((id, i) => proposeEmailUpdate(proposerCtx, id, `af${i}@ex.com`)),
    );

    let inserts = 0;
    const failingApp = new Proxy(pools.app, {
      get(target: Pool, prop: string | symbol, receiver: unknown) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (text: unknown, ...rest: unknown[]) => {
          if (typeof text === "string" && text.includes("insert into app.audit_events")) {
            inserts += 1;
            if (inserts === 3) return Promise.reject(new Error("simulated audit outage"));
          }
          return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
        };
      },
    });
    const failingBroker = makeBroker({ ...pools, app: failingApp }, cfg);

    const result = await failingBroker.decideProposals(approverCtx, {
      decisions: proposals.map((proposalId) => ({ proposalId, action: "approve" as const })),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("internal_error");
    expect(result.failedProposalId).toBeNull();

    // Zero committed revisions: every proposal is still pending, no document changed.
    const stillPending = await app.query(
      `select _rev_status from data_synth.people where _rev = any($1)`,
      [proposals],
    );
    expect(stillPending.rows.every((r) => r._rev_status === "pending")).toBe(true);
    const emails = await app.query(
      `select email from data_synth.people where id = any($1) and _current`,
      [docs],
    );
    expect(emails.rows.some((r) => String(r.email).startsWith("af"))).toBe(false);

    // The refusal rows were written (on the retry: the sink only fails once, on the third of the
    // four `allow` writes attempted inside the now-rolled-back transaction). The two `allow`
    // writes that got out before the failure land as real, separately-committed rows on the
    // control-plane pool — audit writes are not part of the data transaction that rolled back, so
    // they cannot be un-written — but every one of the four INPUT decisions still gets its own
    // `refused`/`batch_aborted` row from the refusal path, which is the property this test pins.
    const rows = await auditRowsFor(result.batchId);
    const refused = rows.filter((r) => r.outcome === "refused");
    expect(refused.length).toBe(4);
    expect(refused.every((r) => r.reason === "batch_aborted")).toBe(true);
  });
});

// §. authorizeDecision is pure — no `await`, no database access — which is what makes it testable
// with hand-built arguments and no provision() at all.
describe("authorizeDecision (pure)", () => {
  const c = cfg.collections.people as CollectionConfig;
  const grant: ActiveGrant = {
    id: "g1",
    allowedFields: ["id", "email", "name", "dept"],
    unmaskedFields: [],
    documentFilter: [],
    verbs: ["read", "approve"],
    mode: "direct",
    principals: ["user:approver"],
    expiresAt: null,
    principal: "user:approver",
  };
  const proposal = {
    _rev: "r1",
    _rev_by: "proposer",
    _rev_op: "update",
    _rev_fields: ["email"],
    _rev_base: 1,
    _rev_seq: 2,
    _rev_status: "pending",
    _current: false,
    workspace_id: "default",
    id: "doc-1",
  } as unknown as RevisionRow;

  it("refuses unknown_collection with no grant named, before anything else is checked", () => {
    const res = authorizeDecision(
      { userId: "approver" },
      "people",
      null,
      grant,
      proposal,
      "approve",
    );
    expect(res).toEqual({ ok: false, reason: "unknown_collection", grant: null });
  });

  it("refuses no_grant on approve when no grant was loaded", () => {
    const res = authorizeDecision({ userId: "approver" }, "people", c, null, proposal, "approve");
    expect(res).toEqual({ ok: false, reason: "no_grant", grant: null });
  });

  it("refuses self_approval_denied before the verb check", () => {
    const noApprove = { ...grant, verbs: ["read"] };
    // Even holding no approve verb, a self-approval is reported for what it is.
    const res = authorizeDecision(
      { userId: "proposer" },
      "people",
      c,
      noApprove,
      proposal,
      "approve",
    );
    expect(res).toEqual({ ok: false, reason: "self_approval_denied", grant: noApprove });
  });

  it("refuses verb_denied when the grant lacks approve", () => {
    const noApprove = { ...grant, verbs: ["read"] };
    const res = authorizeDecision(
      { userId: "approver" },
      "people",
      c,
      noApprove,
      proposal,
      "approve",
    );
    expect(res).toEqual({ ok: false, reason: "verb_denied", grant: noApprove });
  });

  it("refuses field_denied when a proposed field is outside allowedFields", () => {
    const narrow = { ...grant, allowedFields: ["id", "name"] };
    const res = authorizeDecision({ userId: "approver" }, "people", c, narrow, proposal, "approve");
    expect(res).toEqual({ ok: false, reason: "field_denied", grant: narrow });
  });

  it("succeeds with the collection's pk on a clean approve", () => {
    const res = authorizeDecision({ userId: "approver" }, "people", c, grant, proposal, "approve");
    expect(res).toEqual({ ok: true, pk: "id" });
  });

  it("reject collapses no grant and missing approve verb into one verb_denied", () => {
    const res = authorizeDecision({ userId: "approver" }, "people", c, null, proposal, "reject");
    expect(res).toEqual({ ok: false, reason: "verb_denied", grant: null });

    const noApprove = { ...grant, verbs: ["read"] };
    const res2 = authorizeDecision(
      { userId: "approver" },
      "people",
      c,
      noApprove,
      proposal,
      "reject",
    );
    expect(res2).toEqual({ ok: false, reason: "verb_denied", grant: noApprove });
  });

  it("reject still enforces four eyes", () => {
    const res = authorizeDecision({ userId: "proposer" }, "people", c, grant, proposal, "reject");
    expect(res).toEqual({ ok: false, reason: "self_approval_denied", grant });
  });

  it("reject does not check field coverage — it never reads proposed values", () => {
    const narrow = { ...grant, allowedFields: ["id"] }; // missing "email", which the proposal touches
    const res = authorizeDecision({ userId: "approver" }, "people", c, narrow, proposal, "reject");
    expect(res).toEqual({ ok: true, pk: "id" });
  });
});
