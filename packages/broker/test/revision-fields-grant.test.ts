import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { makeCtx } from "./helpers/ctx";
import { ConfigSchema } from "../src/config/schema";
import { applyConfig, makeBroker, migrateApp, createPools } from "../src/index";

// `notes` is readable, `secret_memo` is not. A revision touching both must report only `notes`.
const CONFIG = ConfigSchema.parse({
  project: "t",
  collections: {
    tasks: {
      description: "Tasks",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        notes: { type: "text", posture: { read: "allow", write: "allow" } },
        secret_memo: { type: "text", posture: { read: "deny", write: "allow" } },
      },
    },
  },
});

describe("listRevisions field disclosure", () => {
  let p: Provisioned;
  let app: Pool;
  let pools: ReturnType<typeof createPools>;
  let broker: ReturnType<typeof makeBroker>;
  const ID = "11111111-1111-4111-8111-111111111111";

  beforeAll(async () => {
    p = await provision("revision-fields-grant");
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

    // A grant carrying `notes` only. `secret_memo` is posture-denied, so it is not grantable.
    await app.query(
      `insert into app.grants (id, workspace_id, user_id, principal, collection, purpose_label,
         allowed_fields, verbs, mode, env, status, requested_at, decided_at)
       values (gen_random_uuid(), 'default', 'alice', 'user:alice', 'tasks', 'test',
         array['id','notes'], array['read','create','update'], 'direct', 'dev', 'approved', now(), now())`,
    );
  }, 120_000);

  afterAll(async () => {
    await pools.end();
    await app.end();
    await p.end();
  });

  it("never names a denied field in a revision's field list", async () => {
    const ctx = makeCtx({ userId: "alice" });
    const created = await broker.mutate(ctx, {
      op: "create",
      collection: "tasks",
      values: { id: ID, notes: "first" },
    });
    expect(created.ok).toBe(true);

    // Write both fields directly, as an import would, so the revision genuinely touched a
    // field the caller cannot read.
    await app.query(`update data_synth.tasks set _current = false where id = $1 and _current`, [
      ID,
    ]);
    await app.query(
      `insert into data_synth.tasks
         (_rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _rev_base,
          _current, workspace_id, id, notes, secret_memo)
       values (gen_random_uuid(), 2, now(), 'importer', 'update', 'approved',
          array['notes','secret_memo'], 1, true, 'default', $1, 'second', 'CANARY_MEMO')`,
      [ID],
    );

    const res = await broker.listRevisions(ctx, { collection: "tasks", id: ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const second = res.revisions.find((r) => r.seq === 2);
    expect(second?.fields).toEqual(["notes"]);
    expect(JSON.stringify(res)).not.toContain("secret_memo");
    expect(JSON.stringify(res)).not.toContain("CANARY_MEMO");
  });
});
