import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { makeCtx } from "./helpers/ctx";
import { ConfigSchema } from "../src/config/schema";
import { applyConfig, makeBroker, migrateApp, createPools } from "../src/index";

// `title` and `notes` are writable; `locked` is readable but never writable.
const CONFIG = ConfigSchema.parse({
  project: "t",
  collections: {
    tasks: {
      description: "Tasks",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
        notes: { type: "text", posture: { read: "allow", write: "allow" } },
        locked: { type: "text", posture: { read: "allow", write: "deny" } },
      },
    },
  },
});

const ID = "11111111-1111-4111-8111-111111111111";

describe("revertDocument", () => {
  let p: Provisioned;
  let app: Pool;
  let pools: ReturnType<typeof createPools>;
  let broker: ReturnType<typeof makeBroker>;
  const ctx = makeCtx({ userId: "alice" });

  async function grant(
    fields: string[],
    mode = "direct",
    opts: { verbs?: string[]; documentFilter?: unknown } = {},
  ) {
    await app.query(`delete from app.grants where user_id = 'alice'`);
    await app.query(
      `insert into app.grants (id, workspace_id, user_id, principal, collection, purpose_label,
         allowed_fields, verbs, mode, env, status, requested_at, decided_at, document_filter)
       values (gen_random_uuid(), 'default', 'alice', 'user:alice', 'tasks', 'test',
         $1, $2, $3, 'dev', 'approved', now(), now(), $4)`,
      [
        fields,
        opts.verbs ?? ["read", "create", "update", "delete"],
        mode,
        opts.documentFilter ? JSON.stringify(opts.documentFilter) : null,
      ],
    );
  }

  // No grant row at all for alice, as opposed to `grant()` with an empty field list.
  async function noGrant() {
    await app.query(`delete from app.grants where user_id = 'alice'`);
  }

  async function seed() {
    await app.query(`delete from data_synth.tasks`);
    await app.query(
      `insert into data_synth.tasks
         (_rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _rev_base,
          _current, workspace_id, id, title, notes, locked)
       values ('33333331-3333-4333-8333-333333333333', 1, now(), 'alice', 'create', 'approved',
          array['title','notes'], null, false, 'default', $1, 'first', 'note one', 'L1'),
              ('33333332-3333-4333-8333-333333333333', 2, now(), 'alice', 'update', 'approved',
          array['title'], 1, true, 'default', $1, 'second', 'note one', 'L1')`,
      [ID],
    );
  }

  beforeAll(async () => {
    p = await provision("revert");
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
  }, 120_000);

  afterAll(async () => {
    await pools.end?.();
    await app.end();
    await p.end();
  });

  const REV1 = "33333331-3333-4333-8333-333333333333";

  it("appends a new revision rather than rewinding", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"]);
    const res = await broker.revertDocument(ctx, { collection: "tasks", id: ID, rev: REV1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe("applied");

    const rows = await app.query<{ _rev_seq: string; title: string; _current: boolean }>(
      `select _rev_seq, title, _current from data_synth.tasks where id=$1 order by _rev_seq`,
      [ID],
    );
    expect(rows.rows.map((r) => Number(r._rev_seq))).toEqual([1, 2, 3]);
    // The old revisions are untouched.
    expect(rows.rows[0]!.title).toBe("first");
    expect(rows.rows[1]!.title).toBe("second");
    // The new one carries the reverted value and is current.
    expect(rows.rows[2]!.title).toBe("first");
    expect(rows.rows[2]!._current).toBe(true);
  });

  it("writes only the fields that differ", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"]);
    await broker.revertDocument(ctx, { collection: "tasks", id: ID, rev: REV1 });
    const r = await app.query<{ _rev_fields: string[] }>(
      `select _rev_fields from data_synth.tasks where id=$1 and _rev_seq=3`,
      [ID],
    );
    // `notes` and `locked` are identical in both revisions, so neither is written.
    expect(r.rows[0]!._rev_fields).toEqual(["title"]);
  });

  it("succeeds when an UNCHANGED field is not writable", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"]);
    // `locked` is write-deny and identical across revisions, so it is never in `values`.
    const res = await broker.revertDocument(ctx, { collection: "tasks", id: ID, rev: REV1 });
    expect(res.ok).toBe(true);
  });

  it("refuses the whole revert when a CHANGED field is not writable", async () => {
    await seed();
    // Make `locked` differ between the two revisions.
    await app.query(`update data_synth.tasks set locked = 'L2' where _rev_seq = 2`);
    await grant(["id", "title", "notes", "locked"]);
    const res = await broker.revertDocument(ctx, { collection: "tasks", id: ID, rev: REV1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("field_not_writable");

    const n = await app.query<{ n: string }>(
      `select count(*) as n from data_synth.tasks where id=$1`,
      [ID],
    );
    expect(Number(n.rows[0]!.n)).toBe(2);
  });

  it("returns pending and writes no revision under a proposal_only grant", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"], "proposal_only");
    const res = await broker.revertDocument(ctx, { collection: "tasks", id: ID, rev: REV1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe("pending");
    const cur = await app.query<{ title: string }>(
      `select title from data_synth.tasks where id=$1 and _current`,
      [ID],
    );
    expect(cur.rows[0]!.title).toBe("second");
  });

  it("refuses conflict on a stale expect", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"]);
    const res = await broker.revertDocument(ctx, {
      collection: "tasks",
      id: ID,
      rev: REV1,
      expect: "99999999-9999-4999-8999-999999999999",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("conflict");
  });

  it("refuses not_found for a revision that does not belong to the document", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"]);
    const res = await broker.revertDocument(ctx, {
      collection: "tasks",
      id: ID,
      rev: "88888888-8888-4888-8888-888888888888",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_found");
  });

  it("is a no-op that still succeeds when reverting to the current revision", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"]);
    const cur = await app.query<{ _rev: string }>(
      `select _rev from data_synth.tasks where id=$1 and _current`,
      [ID],
    );
    const res = await broker.revertDocument(ctx, {
      collection: "tasks",
      id: ID,
      rev: cur.rows[0]!._rev,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe("noop");
  });

  it("writes exactly one change-feed entry for an applied revert", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"]);
    await app.query(`delete from app.change_log`);
    await broker.revertDocument(ctx, { collection: "tasks", id: ID, rev: REV1 });
    const n = await app.query<{ n: string }>(`select count(*) as n from app.change_log`);
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  // The noop path (target revision === current revision) never calls `mutate`, so it must
  // authorise itself. Before the fix it did not: a caller with no grant at all reached the
  // `values.length === 0` short-circuit and got back `{ ok: true, status: "noop", ... }` for a
  // document it had never been granted access to — an existence oracle. This test fails against
  // the unfixed revertDocument and passes once the noop path runs the same grant ladder mutate
  // would have run.
  it("refuses a caller with no grant, even when reverting to the current revision", async () => {
    await seed();
    await noGrant();
    const cur = await app.query<{ _rev: string }>(
      `select _rev from data_synth.tasks where id=$1 and _current`,
      [ID],
    );
    const res = await broker.revertDocument(ctx, {
      collection: "tasks",
      id: ID,
      rev: cur.rows[0]!._rev,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no_grant");
  });

  it("refuses a caller whose grant lacks the update verb", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"], "direct", { verbs: ["read"] });
    const cur = await app.query<{ _rev: string }>(
      `select _rev from data_synth.tasks where id=$1 and _current`,
      [ID],
    );
    const res = await broker.revertDocument(ctx, {
      collection: "tasks",
      id: ID,
      rev: cur.rows[0]!._rev,
    });
    expect(res.ok).toBe(false);
  });

  it("refuses not_found for a document the grant's document filter excludes, when reverting to its current revision", async () => {
    await seed();
    await grant(["id", "title", "notes", "locked"], "direct", {
      documentFilter: [{ field: "title", op: "eq", value: "no-such-title" }],
    });
    const cur = await app.query<{ _rev: string }>(
      `select _rev from data_synth.tasks where id=$1 and _current`,
      [ID],
    );
    const res = await broker.revertDocument(ctx, {
      collection: "tasks",
      id: ID,
      rev: cur.rows[0]!._rev,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_found");
  });
});
