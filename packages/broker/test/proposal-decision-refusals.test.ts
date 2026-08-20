import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import { validateGrantFilters } from "../src/grants/filters";
import type { BrokerContext, DocumentFilter } from "../src/types";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { assertPending } from "./helpers/results";

// The refusal paths on the decision side of a proposal — approve, reject, getProposal,
// listProposals — as opposed to proposal-authz.test.ts, which is about who may decide.
//
// These are the branches the coverage note in vitest.coverage.ts names first: a decision verb
// that refuses for the wrong reason leaks the existence of a document the caller may not see, and
// the two filter checks in particular are the ones that have to answer identically to the read
// path or a grant's document scope means one thing when reading and another when approving.
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
  p = await provision("proposal-decision-refusals");
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

// The same question approveGrant asks, so the helper below routes each filter the way the real
// approval path would rather than by a hand-maintained list of which fixtures are broken.
const isEvaluable = (filters: { field: string; op: string; value: unknown }[]): boolean =>
  validateGrantFilters(filters as DocumentFilter[], cfg.collections.people!) === null;

// A proposer who may only propose, and an approver whose grant the caller shapes. Every test here
// needs the pair, and spelling both out each time buried the one line that was the point.
async function grantPair(
  suffix: string,
  approver: {
    verbs?: string[];
    documentFilters?: { field: string; op: string; value: unknown }[];
    allowedFields?: string[];
  },
) {
  const fields = ["id", "email", "name", "dept"];
  const proposerId = await requestGrant(app, {
    userId: `proposer_${suffix}`,
    collection: "people",
    env: "dev",
    workspaceId: "default",
    purposeLabel: "test",
    allowedFields: fields,
  });
  await approveGrant(app, cfg, proposerId, "admin", {
    verbs: ["read", "create", "update"],
    mode: "proposal_only",
  });

  const approverId = await requestGrant(app, {
    userId: `approver_${suffix}`,
    collection: "people",
    env: "dev",
    workspaceId: "default",
    purposeLabel: "test",
    allowedFields: approver.allowedFields ?? fields,
  });
  await approveGrant(app, cfg, approverId, "admin", {
    verbs: approver.verbs ?? ["read", "approve"],
    ...(approver.documentFilters && isEvaluable(approver.documentFilters)
      ? { documentFilters: approver.documentFilters as never }
      : {}),
  });
  // An unevaluable filter is written past approveGrant, which now refuses one (`invalid_filter`).
  // An approved grant can still carry one — the config may have changed since the decision — and
  // that is precisely the state the first describe block below exercises.
  if (approver.documentFilters && !isEvaluable(approver.documentFilters))
    await app.query(`update app.grants set document_filter=$2 where id=$1`, [
      approverId,
      JSON.stringify(approver.documentFilters),
    ]);

  return {
    proposer: makeCtx({ userId: `proposer_${suffix}` }),
    approver: makeCtx({ userId: `approver_${suffix}` }),
  };
}

async function seedDocument(dept: string, email = "seed@ex.com") {
  const res = await app.query(
    `insert into data_synth.people
       (workspace_id, id, email, name, dept, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
     values ('default', gen_random_uuid(), $1, 'Seed', $2, gen_random_uuid(), 1, now(), 'admin', 'create', 'approved', '{}', true)
     returning id`,
    [email, dept],
  );
  return res.rows[0].id as string;
}

async function proposeUpdate(ctx: BrokerContext, id: string, email: string) {
  const res = await broker.mutate(ctx, {
    collection: "people",
    op: "update",
    id,
    values: { email },
  });
  assertPending(res);
  return res.proposalId;
}

describe("proposal decisions: filters that cannot be evaluated", () => {
  // An approver's filter naming a field the collection does not have is the grant's problem, not
  // the document's. Reported as invalid_intent, the same way query and mutate report it — if it
  // came back not_found the operator would go looking for a missing document that is right there.
  it("approve refuses invalid_intent when the approver's filter names an unknown field", async () => {
    const { proposer, approver } = await grantPair("badfilter", {
      documentFilters: [{ field: "nosuchfield", op: "eq", value: "x" }],
    });
    const docId = await seedDocument("Engineering");
    const proposalId = await proposeUpdate(proposer, docId, "new@ex.com");

    const res = await broker.approveProposal(approver, proposalId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_intent");
    expect(JSON.stringify(res)).not.toContain("nosuchfield");
  });

  it("getProposal refuses invalid_intent on the same filter, so both verbs agree", async () => {
    const { proposer, approver } = await grantPair("badfilter_get", {
      documentFilters: [{ field: "nosuchfield", op: "eq", value: "x" }],
    });
    const docId = await seedDocument("Engineering");
    const proposalId = await proposeUpdate(proposer, docId, "new@ex.com");

    const res = await broker.getProposal(approver, proposalId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_intent");
  });

  // A filter whose value cannot be read as the field's type is unevaluable for the same reason,
  // and has a different shape in the code — the type check, not the name lookup.
  it("approve refuses invalid_intent when the filter value is not of the field's type", async () => {
    const { proposer, approver } = await grantPair("badvalue", {
      documentFilters: [{ field: "id", op: "eq", value: "not-a-uuid" }],
    });
    const docId = await seedDocument("Engineering");
    const proposalId = await proposeUpdate(proposer, docId, "new@ex.com");

    const res = await broker.approveProposal(approver, proposalId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_intent");
  });
});

describe("proposal decisions: documents the decider cannot see", () => {
  // The create case has no current revision to filter, so the check runs against the proposed
  // values instead. It is a separate branch from the update case that proposal-authz.test.ts
  // covers, and getting it wrong would let an approver promote a document into existence outside
  // their own document scope.
  it("approve of a create proposal refuses not_found when the proposed values fail the filter", async () => {
    const { proposer, approver } = await grantPair("create_filtered", {
      documentFilters: [{ field: "dept", op: "eq", value: "Engineering" }],
    });

    const proposed = await broker.mutate(proposer, {
      collection: "people",
      op: "create",
      values: { email: "sales@ex.com", name: "Sales Hire", dept: "Sales" },
    });
    assertPending(proposed);

    const res = await broker.approveProposal(approver, proposed.proposalId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  it("approve of a create proposal promotes when the proposed values pass the filter", async () => {
    const { proposer, approver } = await grantPair("create_passing", {
      documentFilters: [{ field: "dept", op: "eq", value: "Engineering" }],
    });

    const proposed = await broker.mutate(proposer, {
      collection: "people",
      op: "create",
      values: { email: "eng@ex.com", name: "Eng Hire", dept: "Engineering" },
    });
    assertPending(proposed);

    const res = await broker.approveProposal(approver, proposed.proposalId);
    expect(res.ok).toBe(true);
  });

  // The document is gone between proposing and deciding. Not a case a well-behaved caller
  // produces, which is exactly why it is worth pinning: it must refuse, not throw and not promote
  // a revision onto a document that no longer has a current row.
  it("approve refuses not_found when the current revision disappeared after proposing", async () => {
    const { proposer, approver } = await grantPair("vanished", {});
    const docId = await seedDocument("Engineering", "vanish@ex.com");
    const proposalId = await proposeUpdate(proposer, docId, "new@ex.com");

    await app.query(`delete from data_synth.people where id = $1 and _current`, [docId]);

    const res = await broker.approveProposal(approver, proposalId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  it("getProposal refuses not_found when the filter excludes the proposal's document", async () => {
    const { proposer, approver } = await grantPair("get_filtered", {
      documentFilters: [{ field: "dept", op: "eq", value: "Engineering" }],
    });
    const docId = await seedDocument("Sales");
    const proposalId = await proposeUpdate(proposer, docId, "new@ex.com");

    const res = await broker.getProposal(approver, proposalId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });
});

describe("proposal decisions: verbs", () => {
  // getProposal is gated on `approve`, not merely `read`: it exists to inform the decision, and a
  // reader who cannot decide has no call to see a pending diff.
  it("getProposal refuses no_grant for a grant that may read but not approve", async () => {
    const { proposer, approver } = await grantPair("get_noapprove", { verbs: ["read"] });
    const docId = await seedDocument("Engineering");
    const proposalId = await proposeUpdate(proposer, docId, "new@ex.com");

    const res = await broker.getProposal(approver, proposalId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_grant");
  });

  it("reject refuses verb_denied for a grant that may read but not approve", async () => {
    const { proposer, approver } = await grantPair("reject_noapprove", { verbs: ["read"] });
    const docId = await seedDocument("Engineering");
    const proposalId = await proposeUpdate(proposer, docId, "new@ex.com");

    const res = await broker.rejectProposal(approver, proposalId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("verb_denied");

    // And the proposal is still pending — a refused rejection must not half-decide it.
    const row = await app.query(`select _rev_status from data_synth.people where _rev = $1`, [
      proposalId,
    ]);
    expect(row.rows[0]._rev_status).toBe("pending");
  });
});

describe("document_filter is enforced against what a proposal produces", () => {
  // proposeDataset checks the PROPOSER's filter against the values it is about to park — a gap
  // this closes, because approval only ever evaluates the APPROVER's grant.
  it("proposeDataset refuses a proposal whose values fall outside the proposer's own filter", async () => {
    const fields = ["id", "email", "name", "dept"];
    const proposerId = await requestGrant(app, {
      userId: "proposer_ownfilter",
      collection: "people",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "test",
      allowedFields: fields,
    });
    await approveGrant(app, cfg, proposerId, "admin", {
      verbs: ["read", "create"],
      mode: "proposal_only",
      documentFilters: [{ field: "dept", op: "eq", value: "Engineering" }],
    });
    const proposer = makeCtx({ userId: "proposer_ownfilter" });

    const res = await broker.mutate(proposer, {
      collection: "people",
      op: "create",
      values: { email: "sales@ex.com", name: "Sales Hire", dept: "Sales" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  // Approval evaluates the APPROVER's grant against the state the merge PRODUCES, not only the
  // one it replaces — a proposal that leaves the document inside the pre-image but moves it
  // outside the post-image must still be refused, and refusing it must not touch the pending row.
  it("approve refuses an update proposal whose merged state leaves the approver's filter, and the pending row is untouched", async () => {
    const { proposer, approver } = await grantPair("merge_outside", {
      documentFilters: [{ field: "dept", op: "eq", value: "Engineering" }],
    });
    const docId = await seedDocument("Engineering", "mover@ex.com");

    const proposed = await broker.mutate(proposer, {
      collection: "people",
      op: "update",
      id: docId,
      values: { dept: "Sales" },
    });
    assertPending(proposed);

    const res = await broker.approveProposal(approver, proposed.proposalId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");

    const row = await app.query(`select _rev_status from data_synth.people where _rev = $1`, [
      proposed.proposalId,
    ]);
    expect(row.rows[0]._rev_status).toBe("pending");

    const current = await app.query(
      `select dept from data_synth.people where id = $1 and _current`,
      [docId],
    );
    expect(current.rows[0].dept).toBe("Engineering");
  });
});

describe("proposal decisions: listProposals filtering", () => {
  it("omits a pending proposal whose document the caller's filter excludes", async () => {
    const { proposer, approver } = await grantPair("list_filtered", {
      documentFilters: [{ field: "dept", op: "eq", value: "Engineering" }],
    });
    const visible = await seedDocument("Engineering", "visible@ex.com");
    const hidden = await seedDocument("Sales", "hidden@ex.com");
    const visibleProposal = await proposeUpdate(proposer, visible, "v2@ex.com");
    const hiddenProposal = await proposeUpdate(proposer, hidden, "h2@ex.com");

    const res = await broker.listProposals(approver, { status: "pending" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.proposals.map((x) => x.proposalId);
    expect(ids).toContain(visibleProposal);
    expect(ids).not.toContain(hiddenProposal);
  });

  it("omits every proposal in a collection whose grant filter cannot be evaluated", async () => {
    const { proposer, approver } = await grantPair("list_badfilter", {
      documentFilters: [{ field: "nosuchfield", op: "eq", value: "x" }],
    });
    const docId = await seedDocument("Engineering", "unlistable@ex.com");
    const proposalId = await proposeUpdate(proposer, docId, "u2@ex.com");

    const res = await broker.listProposals(approver, { status: "pending" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.proposals.map((x) => x.proposalId)).not.toContain(proposalId);
  });
});
