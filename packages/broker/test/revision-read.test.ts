import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { makeCtx } from "./helpers/ctx";
import { captureLogs } from "./helpers/log-capture";
import { ConfigSchema } from "../src/config/schema";
import { applyConfig, makeBroker, migrateApp, createPools } from "../src/index";

const CONFIG = ConfigSchema.parse({
  project: "t",
  collections: {
    tasks: {
      description: "Tasks",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        owner: { type: "text", posture: { read: "allow", write: "allow" } },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
        account: {
          type: "text",
          posture: { read: "mask", write: "allow" },
          mask: { transform: "last4" },
        },
        // `last4` above emits pure SQL; `first` BINDS its argument. Both are here on purpose: the
        // statement these verbs build already carries positional parameters of its own
        // (workspace, id, and one or two revision ids), so a mask that binds has to number itself
        // after them. A mask expression numbered from $1 would read the workspace id as its
        // character count and the whole projection would be wrong.
        note: {
          type: "text",
          posture: { read: "mask", write: "allow" },
          mask: { transform: "first", chars: 3 },
        },
        secret_memo: { type: "text", posture: { read: "deny", write: "allow" } },
      },
    },
  },
});

const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";

describe("getRevision and diffRevisions", () => {
  let p: Provisioned;
  let app: Pool;
  let pools: ReturnType<typeof createPools>;
  let broker: ReturnType<typeof makeBroker>;
  const ctx = makeCtx({ userId: "alice" });

  beforeAll(async () => {
    p = await provision("revision-read");
    app = testPool({ connectionString: p.urls.admin, max: 2 });
    await migrateApp(app);
    await applyConfig(app, CONFIG);
    pools = createPools({
      app: p.urls.admin,
      dev: p.urls.dev,
      live: p.urls.live,
      devWrite: p.urls.devWrite,
      liveWrite: p.urls.liveWrite,
    });
    broker = makeBroker(pools, CONFIG);

    await app.query(
      `insert into app.grants (id, workspace_id, user_id, principal, collection, purpose_label,
         allowed_fields, verbs, mode, env, status, document_filter, requested_at, decided_at)
       values (gen_random_uuid(), 'default', 'alice', 'user:alice', 'tasks', 'test',
         array['id','owner','title','account','note'], array['read','create','update','delete'],
         'direct', 'dev', 'approved', '[{"field":"owner","op":"eq","value":"$self"}]'::jsonb,
         now(), now())`,
    );

    // Two revisions of alice's document, and one document owned by somebody else.
    for (const [seq, title, account, memo, note, current] of [
      [1, "first", "4111111111111111", "MEMO_CANARY_ONE", "alpha-one", false],
      [2, "second", "4222222222222222", "MEMO_CANARY_TWO", "bravo-two", true],
    ] as const) {
      await app.query(
        `insert into data_synth.tasks
           (_rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _rev_base,
            _current, workspace_id, id, owner, title, account, secret_memo, note)
         values ($1, $2, now(), 'alice', $3, 'approved', array['title','account','secret_memo'],
            null, $4, 'default', $5, 'alice', $6, $7, $8, $9)`,
        [
          `3333333${seq}-3333-4333-8333-333333333333`,
          seq,
          seq === 1 ? "create" : "update",
          current,
          MINE,
          title,
          account,
          memo,
          note,
        ],
      );
    }
    await app.query(
      `insert into data_synth.tasks
         (_rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _rev_base,
          _current, workspace_id, id, owner, title, account, secret_memo, note)
       values (gen_random_uuid(), 1, now(), 'bob', 'create', 'approved', array['title'], null,
          true, 'default', $1, 'bob', 'theirs', '4999999999999999', 'OTHER', 'charlie')`,
      [THEIRS],
    );
  }, 120_000);

  afterAll(async () => {
    await pools.end();
    await app.end();
    await p.end();
  });

  const REV1 = "33333331-3333-4333-8333-333333333333";
  const REV2 = "33333332-3333-4333-8333-333333333333";

  it("returns the document as of a past revision, through the caller's granted fields", async () => {
    const res = await broker.getRevision(ctx, { collection: "tasks", id: MINE, rev: REV1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.revision.seq).toBe(1);
    expect(res.revision.document.title).toBe("first");
    expect(res.fieldsReturned.sort()).toEqual(["account", "id", "note", "owner", "title"]);
  });

  it("omits a denied field entirely, and never logs its value", async () => {
    const logs = captureLogs();
    try {
      const res = await broker.getRevision(ctx, { collection: "tasks", id: MINE, rev: REV1 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(Object.keys(res.revision.document)).not.toContain("secret_memo");
      expect(JSON.stringify(res)).not.toContain("MEMO_CANARY_ONE");
    } finally {
      expect(logs.text()).not.toContain("MEMO_CANARY_ONE");
      logs.restore();
    }
  });

  it("masks a masked field rather than returning it raw", async () => {
    const res = await broker.getRevision(ctx, { collection: "tasks", id: MINE, rev: REV1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.revision.document.account).not.toBe("4111111111111111");
    expect(String(res.revision.document.account)).toContain("1111");
  });

  // The mask that BINDS. `first` numbers its argument after the statement's own positional
  // parameters, so a projection that got the numbering wrong would either error or silently read
  // the workspace id as the character count.
  it("masks a field whose transform binds a parameter, numbered after the statement's own", async () => {
    const res = await broker.getRevision(ctx, { collection: "tasks", id: MINE, rev: REV1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.revision.document.note).toBe("alp…");
    expect(JSON.stringify(res)).not.toContain("alpha-one");
  });

  it("refuses not_found for a document the grant's document filter excludes", async () => {
    const res = await broker.getRevision(ctx, {
      collection: "tasks",
      id: THEIRS,
      rev: "44444444-4444-4444-8444-444444444444",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_found");
  });

  it("refuses not_found for a revision id belonging to another document", async () => {
    const res = await broker.getRevision(ctx, { collection: "tasks", id: THEIRS, rev: REV1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_found");
  });

  it("refuses no_grant for a caller with no grant", async () => {
    const res = await broker.getRevision(makeCtx({ userId: "nobody" }), {
      collection: "tasks",
      id: MINE,
      rev: REV1,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no_grant");
  });

  it("refuses unknown_collection without disclosing anything else", async () => {
    const res = await broker.getRevision(ctx, { collection: "nope", id: MINE, rev: REV1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unknown_collection");
  });

  it("writes exactly one audit row per call, allow or refuse", async () => {
    const before = await app.query<{ n: string }>(`select count(*) as n from app.audit_events`);
    await broker.getRevision(ctx, { collection: "tasks", id: MINE, rev: REV1 });
    await broker.getRevision(ctx, { collection: "nope", id: MINE, rev: REV1 });
    const after = await app.query<{ n: string }>(`select count(*) as n from app.audit_events`);
    expect(Number(after.rows[0]!.n) - Number(before.rows[0]!.n)).toBe(2);
  });

  it("reports only the fields the caller can read, with both sides masked", async () => {
    const res = await broker.diffRevisions(ctx, {
      collection: "tasks",
      id: MINE,
      from: REV1,
      to: REV2,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byField = Object.fromEntries(res.changes.map((c) => [c.field, c]));
    expect(byField.title).toEqual({ field: "title", before: "first", after: "second" });
    // secret_memo changed between the two revisions and must not be reported at all.
    expect(byField.secret_memo).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("MEMO_CANARY_ONE");
    expect(JSON.stringify(res)).not.toContain("MEMO_CANARY_TWO");
    // account changed, but both sides are masked, so neither raw value appears.
    expect(JSON.stringify(res)).not.toContain("4111111111111111");
    expect(JSON.stringify(res)).not.toContain("4222222222222222");
  });

  it("reports a bind-masked field's change through the mask on both sides", async () => {
    const res = await broker.diffRevisions(ctx, {
      collection: "tasks",
      id: MINE,
      from: REV1,
      to: REV2,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const note = res.changes.find((c) => c.field === "note");
    expect(note).toEqual({ field: "note", before: "alp…", after: "bra…" });
    expect(JSON.stringify(res)).not.toContain("alpha-one");
    expect(JSON.stringify(res)).not.toContain("bravo-two");
  });

  it("returns an empty change list for a revision compared with itself", async () => {
    const res = await broker.diffRevisions(ctx, {
      collection: "tasks",
      id: MINE,
      from: REV1,
      to: REV1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changes).toEqual([]);
  });

  it("refuses not_found when either revision does not belong to the document", async () => {
    const res = await broker.diffRevisions(ctx, {
      collection: "tasks",
      id: MINE,
      from: REV1,
      to: "55555555-5555-4555-8555-555555555555",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_found");
  });
});
