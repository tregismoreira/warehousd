import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";
import { makeCtx } from "./helpers/ctx";
import { assertPending } from "./helpers/results";

// Per-document ACLs on the WRITE path, and the authorization around editing an ACL at all.
//
// The write path cannot reuse the read path's SQL — it reads base tables for the `_rev*`
// bookkeeping the view does not expose — so it re-evaluates in process, through `admits()`. This
// file exercises every former `matchesFilters` call site: mutate (update/delete), propose
// (update/delete), approve (create and update proposals), listProposals, getProposal and
// listRevisions. Each fails without the change: before it, an ACL was a read-path rule only and a
// caller excluded from a document could still edit it.

const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  collections: {
    content: {
      description: "Pages",
      writable: true,
      acl: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
        body: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

const FIELDS = ["id", "title", "body"];

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
let restrictedId: string, publicId: string;

async function grant(
  userId: string,
  opts: { verbs?: string[]; mode?: "direct" | "proposal_only" } = {},
) {
  await admin.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,verbs,mode)
     values ($1,'content',$2,'dev','approved',$3,$4)`,
    [
      userId,
      FIELDS,
      opts.verbs ?? ["read", "create", "update", "delete", "approve"],
      opts.mode ?? "direct",
    ],
  );
}

beforeAll(async () => {
  p = await provision("acl-write");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);

  // Better Auth owns app."user" in a real deployment (see db/migrate-app.ts), so the broker suite
  // stands in the two columns the console-role check reads.
  await admin.query(
    `create table if not exists app."user" (
       id text primary key, role text, "workspaceId" text not null default 'default')`,
  );

  await admin.query(
    `insert into data_synth.content (${R}, id, title, body) values
       (${RV}, gen_random_uuid(), 'restricted', 'r'),
       (${RV}, gen_random_uuid(), 'public', 'p')`,
  );
  restrictedId = (
    await admin.query<{ id: string }>(`select id from data_synth.content where title='restricted'`)
  ).rows[0]!.id;
  publicId = (
    await admin.query<{ id: string }>(`select id from data_synth.content where title='public'`)
  ).rows[0]!.id;

  await admin.query(
    `insert into data_synth."_acl" (workspace_id, collection, document_id, principals, updated_by)
     values ('default','content',$1, array['user:owner','group:reviewers'],'test')`,
    [restrictedId],
  );
  await admin.query(
    `insert into app.user_groups (workspace_id, user_id, group_name, source) values
       ('default','reviewer_in','reviewers','sso'),
       ('default','proposer','reviewers','manual')`,
  );

  await grant("owner");
  await grant("outsider");
  await grant("proposer", { verbs: ["read", "update", "delete"], mode: "proposal_only" });
  await grant("reviewer_in", { verbs: ["read", "approve"] });
  await grant("reviewer_out", { verbs: ["read", "approve"] });
  await grant("acl_manager");

  pools = createPools({
    app: p.urls.admin,
    dev: p.urls.dev,
    live: p.urls.live,
    devWrite: p.urls.devWrite,
    liveWrite: p.urls.liveWrite,
  });
  broker = makeBroker(pools, cfg);
}, 120_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

describe("the direct write path", () => {
  it("refuses an update on a document the caller is not on the ACL of", async () => {
    const r = await broker.mutate(makeCtx({ userId: "outsider" }), {
      collection: "content",
      op: "update",
      id: restrictedId,
      values: { title: "hijacked" },
    });
    expect(r.ok).toBe(false);
    // not_found, never a distinct reason: telling an excluded caller that the document exists is
    // the disclosure the ACL was written to prevent.
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("refuses a delete for the same caller", async () => {
    const r = await broker.mutate(makeCtx({ userId: "outsider" }), {
      collection: "content",
      op: "delete",
      id: restrictedId,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("allows the same update for a principal on the ACL", async () => {
    const r = await broker.mutate(makeCtx({ userId: "owner" }), {
      collection: "content",
      op: "update",
      id: restrictedId,
      values: { title: "restricted" },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("leaves a document with no ACL row writable by anyone the grant covers", async () => {
    const r = await broker.mutate(makeCtx({ userId: "outsider" }), {
      collection: "content",
      op: "update",
      id: publicId,
      values: { title: "public" },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe("the proposal path", () => {
  it("refuses a proposed update from a caller not on the ACL", async () => {
    await grant("proposer_out", {
      verbs: ["read", "update", "delete"],
      mode: "proposal_only",
    });
    const r = await broker.mutate(makeCtx({ userId: "proposer_out" }), {
      collection: "content",
      op: "update",
      id: restrictedId,
      values: { body: "no" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("refuses a proposed delete from the same caller", async () => {
    const r = await broker.mutate(makeCtx({ userId: "proposer_out" }), {
      collection: "content",
      op: "delete",
      id: restrictedId,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  // One pending revision on the restricted document, proposed by somebody who IS on its ACL, so
  // that every decision verb below has something real to refuse.
  let proposalId: string;

  it("accepts a proposal from a caller the ACL admits, through a group", async () => {
    const r = await broker.mutate(makeCtx({ userId: "proposer" }), {
      collection: "content",
      op: "update",
      id: restrictedId,
      values: { body: "proposed" },
    });
    assertPending(r);
    proposalId = r.proposalId;
  });

  it("approveProposal refuses for an approver not on the ACL", async () => {
    const r = await broker.approveProposal(makeCtx({ userId: "reviewer_out" }), proposalId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("getProposal refuses for the same approver", async () => {
    const r = await broker.getProposal(makeCtx({ userId: "reviewer_out" }), proposalId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("listProposals omits it for that approver and lists it for one the ACL admits", async () => {
    const out = await broker.listProposals(makeCtx({ userId: "reviewer_out" }), {
      collection: "content",
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (out.ok) expect(out.proposals.map((x) => x.proposalId)).not.toContain(proposalId);

    const inn = await broker.listProposals(makeCtx({ userId: "reviewer_in" }), {
      collection: "content",
    });
    expect(inn.ok, JSON.stringify(inn)).toBe(true);
    if (inn.ok) expect(inn.proposals.map((x) => x.proposalId)).toContain(proposalId);
  });

  it("approveProposal succeeds for an approver the ACL admits", async () => {
    const r = await broker.approveProposal(makeCtx({ userId: "reviewer_in" }), proposalId);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("a CREATE proposal is checked against an ACL written before the document exists", async () => {
    // An ACL is keyed on the pk, so nothing stops one being written for a document that has not
    // been approved into existence yet. approveProposal has no current revision to read there and
    // builds the row from the proposal itself — this is the assertion that it carries the ACL too.
    await grant("creator", { verbs: ["read", "create"], mode: "proposal_only" });
    const created = await broker.mutate(makeCtx({ userId: "creator" }), {
      collection: "content",
      op: "create",
      values: { title: "born restricted", body: "b" },
    });
    assertPending(created);

    const newId = (
      await admin.query<{ id: string }>(`select id from data_synth.content where _rev = $1`, [
        created.proposalId,
      ])
    ).rows[0]!.id;
    await admin.query(
      `insert into data_synth."_acl" (workspace_id, collection, document_id, principals, updated_by)
       values ('default','content',$1, array['user:owner'],'test')`,
      [newId],
    );

    const denied = await broker.approveProposal(
      makeCtx({ userId: "reviewer_out" }),
      created.proposalId,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("not_found");
  });
});

describe("listRevisions", () => {
  it("refuses a document the caller is not on the ACL of", async () => {
    const r = await broker.listRevisions(makeCtx({ userId: "outsider" }), {
      collection: "content",
      id: restrictedId,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("returns history for a principal the ACL admits", async () => {
    const r = await broker.listRevisions(makeCtx({ userId: "owner" }), {
      collection: "content",
      id: restrictedId,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.revisions.length).toBeGreaterThan(0);
  });
});

describe("ACL management authorization", () => {
  const console_ = { kind: "console" } as const;

  it("refuses a client whose policy does not carry can_manage_acl", async () => {
    await admin.query(
      `insert into app.client_policies (client_id, display_name) values ('plain-client','plain')`,
    );
    const r = await broker.setDocumentAcl(
      makeCtx({ userId: "acl_manager", via: "api_key:plain-client" }),
      { kind: "client", clientId: "plain-client" },
      { collection: "content", id: publicId, principals: ["user:owner"] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("acl_denied");
  });

  it("refuses an unknown client outright — no policy row is not 'no ceiling' here", async () => {
    const r = await broker.getDocumentAcl(
      makeCtx({ userId: "acl_manager" }),
      { kind: "client", clientId: "never-registered" },
      { collection: "content", id: publicId },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("acl_denied");
  });

  it("admits a client the flag was set on, and the write takes effect on the read path", async () => {
    await admin.query(
      `insert into app.client_policies (client_id, display_name, can_manage_acl)
       values ('acme-app','Acme App',true)`,
    );
    const set = await broker.setDocumentAcl(
      makeCtx({ userId: "acl_manager" }),
      { kind: "client", clientId: "acme-app" },
      { collection: "content", id: publicId, principals: ["user:owner", "user:owner"] },
    );
    expect(set.ok, JSON.stringify(set)).toBe(true);
    // Deduplicated: an ACL is a set.
    if (set.ok) expect(set.acl.principals).toEqual(["user:owner"]);

    const gone = await broker.getDocument(makeCtx({ userId: "outsider" }), {
      collection: "content",
      id: publicId,
    });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toBe("not_found");
  });

  it("an empty list removes the row, and the document is public again", async () => {
    const cleared = await broker.setDocumentAcl(
      makeCtx({ userId: "acl_manager" }),
      { kind: "client", clientId: "acme-app" },
      { collection: "content", id: publicId, principals: [] },
    );
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    const rows = await admin.query(`select 1 from data_synth."_acl" where document_id = $1`, [
      publicId,
    ]);
    expect(rows.rowCount).toBe(0);

    const back = await broker.getDocument(makeCtx({ userId: "outsider" }), {
      collection: "content",
      id: publicId,
    });
    expect(back.ok, JSON.stringify(back)).toBe(true);
  });

  it("rejects a principal with no namespace, and one with an unknown namespace", async () => {
    for (const bad of [["owner"], ["role:admin"], ["user:"], [42], "user:owner"]) {
      const r = await broker.setDocumentAcl(
        makeCtx({ userId: "acl_manager" }),
        { kind: "client", clientId: "acme-app" },
        { collection: "content", id: publicId, principals: bad },
      );
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_intent");
    }
  });

  it("admits a console manager and refuses a console member", async () => {
    await admin.query(
      `insert into app."user" (id, role, "workspaceId") values
         ('mgr','manager','default'), ('mem','member','default')`,
    );
    await admin.query(
      `insert into app.workspace_members (workspace_id, user_id, role) values
         ('default','mgr','manager'), ('default','mem','member')`,
    );
    const ok = await broker.getDocumentAcl(makeCtx({ userId: "mgr" }), console_, {
      collection: "content",
      id: publicId,
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);

    const no = await broker.setDocumentAcl(makeCtx({ userId: "mem" }), console_, {
      collection: "content",
      id: publicId,
      principals: ["user:mem"],
    });
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.reason).toBe("acl_denied");
  });

  it("refuses a collection that does not declare acl: true", async () => {
    const r = await broker.getDocumentAcl(
      makeCtx({ userId: "acl_manager" }),
      { kind: "client", clientId: "acme-app" },
      { collection: "nope", id: publicId },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_collection");
  });

  it("audits every call — allow and refusal alike", async () => {
    const before = await admin.query<{ n: number }>(
      `select count(*)::int as n from app.audit_events where collection='content'`,
    );
    const allowed = await broker.getDocumentAcl(
      makeCtx({ userId: "acl_manager" }),
      { kind: "client", clientId: "acme-app" },
      { collection: "content", id: publicId },
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.auditId).not.toBeNull();

    const refused = await broker.setDocumentAcl(
      makeCtx({ userId: "acl_manager" }),
      { kind: "client", clientId: "plain-client" },
      { collection: "content", id: publicId, principals: ["user:x"] },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.auditId).not.toBeNull();

    const after = await admin.query<{ n: number }>(
      `select count(*)::int as n from app.audit_events where collection='content'`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 2);
  });
});
