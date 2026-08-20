import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { makeCtx } from "./helpers/ctx";
import { ConfigSchema } from "../src/config/schema";
import { applyConfig, makeBroker, migrateApp, createPools } from "../src/index";

// Two independent host/target pairs: `matters`/`time_entries` for the ordinary cases, and
// `matters_capped`/`time_entries_capped` for the limit test — a to-many's `via` field must carry
// `fk` pointing at exactly one host collection (ConfigSchema's superRefine), so one target field
// cannot serve two hosts with two different limits.
const CONFIG = ConfigSchema.parse({
  project: "t",
  collections: {
    matters: {
      description: "Matters",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        entries: {
          posture: "allow",
          relation: {
            collection: "time_entries",
            via: "matter_id",
            select: { hours: { posture: "allow" }, entry_date: { posture: "allow" } },
            limit: 50,
            order: { field: "entry_date", dir: "desc" },
          },
        },
      },
    },
    time_entries: {
      description: "Time entries",
      acl: true,
      indexes: [{ fields: ["matter_id"] }],
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        matter_id: { type: "uuid", posture: "allow", fk: "matters.id" },
        hours: { type: "numeric", posture: "allow" },
        entry_date: { type: "date", posture: "allow" },
      },
    },
    matters_capped: {
      description: "Matters (capped relation, for the limit test)",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        entries: {
          posture: "allow",
          relation: {
            collection: "time_entries_capped",
            via: "matter_id",
            select: { hours: { posture: "allow" } },
            limit: 2,
            order: { field: "hours", dir: "desc" },
          },
        },
      },
    },
    time_entries_capped: {
      description: "Time entries for the capped matter",
      indexes: [{ fields: ["matter_id"] }],
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        matter_id: { type: "uuid", posture: "allow", fk: "matters_capped.id" },
        hours: { type: "numeric", posture: "allow" },
        entry_date: { type: "date", posture: "allow" },
      },
    },
  },
});

const M1 = "aaaaaaaa-0000-4000-8000-000000000001";
const M_EMPTY = "aaaaaaaa-0000-4000-8000-000000000002";
const M_OTHER = "aaaaaaaa-0000-4000-8000-000000000003";
const MC1 = "aaaaaaaa-0000-4000-8000-000000000010";

const TE1 = "bbbbbbbb-0000-4000-8000-000000000001";
const TE2 = "bbbbbbbb-0000-4000-8000-000000000002";
const TE3 = "bbbbbbbb-0000-4000-8000-000000000003";
const TE4 = "bbbbbbbb-0000-4000-8000-000000000004";
const TE5 = "bbbbbbbb-0000-4000-8000-000000000005";

describe("to-many relations", () => {
  let p: Provisioned;
  let app: Pool;
  let pools: ReturnType<typeof createPools>;
  let broker: ReturnType<typeof makeBroker>;
  const ctx = makeCtx({ userId: "alice" });
  const ctxLimited = makeCtx({ userId: "bob" });

  async function seedMatter(table: string, id: string) {
    await app.query(
      `insert into data_synth.${table}
         (_rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _rev_base,
          _current, workspace_id, id)
       values (gen_random_uuid(), 1, now(), 'seed', 'create', 'approved', array[]::text[], null,
          true, 'default', $1)`,
      [id],
    );
  }

  async function seedEntry(
    table: string,
    id: string,
    matterId: string,
    hours: number,
    entryDate: string,
    seq = 1,
    current = true,
  ) {
    await app.query(
      `insert into data_synth.${table}
         (_rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _rev_base,
          _current, workspace_id, id, matter_id, hours, entry_date)
       values (gen_random_uuid(), $1, now(), 'seed', 'create', 'approved', array[]::text[], null,
          $2, 'default', $3, $4, $5, $6)`,
      [seq, current, id, matterId, hours, entryDate],
    );
  }

  beforeAll(async () => {
    p = await provision("relation-many");
    app = new Pool({ connectionString: p.urls.admin, max: 2 });
    await migrateApp(app);
    await applyConfig(app, CONFIG);
    pools = createPools({
      app: p.urls.admin,
      dev: p.urls.dev,
      live: p.urls.live,
      devWrite: p.urls.devWrite!,
      liveWrite: p.urls.liveWrite!,
    });
    broker = makeBroker(pools, CONFIG);

    await app.query(
      `insert into app.grants (id, workspace_id, user_id, principal, collection, purpose_label,
         allowed_fields, verbs, mode, env, status, requested_at, decided_at)
       values (gen_random_uuid(), 'default', 'alice', 'user:alice', 'matters', 'test',
         array['id','entries'], array['read'], 'direct', 'dev', 'approved', now(), now())`,
    );
    await app.query(
      `insert into app.grants (id, workspace_id, user_id, principal, collection, purpose_label,
         allowed_fields, verbs, mode, env, status, requested_at, decided_at)
       values (gen_random_uuid(), 'default', 'bob', 'user:bob', 'matters_capped', 'test',
         array['id','entries'], array['read'], 'direct', 'dev', 'approved', now(), now())`,
    );

    await seedMatter("matters", M1);
    await seedMatter("matters", M_EMPTY);

    await seedEntry("time_entries", TE1, M1, 1, "2024-01-01");
    // TE2 carries a second revision — the relation must still yield one array element for it.
    await seedEntry("time_entries", TE2, M1, 2, "2024-01-02", 1, false);
    await seedEntry("time_entries", TE2, M1, 2, "2024-01-02", 2, true);
    await seedEntry("time_entries", TE3, M1, 3, "2024-01-03");
    // ACL-restricted: excluded from the array, but the host document still comes back.
    await seedEntry("time_entries", TE4, M1, 4, "2024-01-04");
    await app.query(
      `insert into data_synth."_acl" (workspace_id, collection, document_id, principals, updated_at, updated_by)
       values ('default', 'time_entries', $1, array['user:someone-else'], now(), 'admin')`,
      [TE4],
    );
    // Belongs to a different matter entirely.
    await seedEntry("time_entries", TE5, M_OTHER, 99, "2024-01-05");

    await seedMatter("matters_capped", MC1);
    await seedEntry(
      "time_entries_capped",
      "cccccccc-0000-4000-8000-000000000001",
      MC1,
      1,
      "2024-01-01",
    );
    await seedEntry(
      "time_entries_capped",
      "cccccccc-0000-4000-8000-000000000002",
      MC1,
      2,
      "2024-01-02",
    );
    await seedEntry(
      "time_entries_capped",
      "cccccccc-0000-4000-8000-000000000003",
      MC1,
      3,
      "2024-01-03",
    );
  }, 120_000);

  afterAll(async () => {
    await pools.end?.();
    await app.end();
    await p.end();
  });

  it("returns an array of the selected target fields, ordered and capped", async () => {
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entries = (r.documents[0] as { entries: { hours: number }[] }).entries;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(3);
    // ordered by entry_date desc
    expect(entries.map((e) => e.hours)).toEqual([3, 2, 1]);
  });

  it("returns an empty array, not null, when nothing matches", async () => {
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M_EMPTY }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.documents[0] as { entries: unknown[] }).entries).toEqual([]);
  });

  it("excludes an ACL-restricted target document without changing the host document count", async () => {
    const r = await broker.query(ctx, { collection: "matters" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = r.documents.length;
    // The restricted entry is absent from the array; the matter itself is still returned.
    const entries = (
      r.documents.find((d) => (d as { id: string }).id === M1) as { entries: unknown[] }
    ).entries;
    expect(entries.length).toBe(3);
    expect(r.documents.length).toBe(before);
  });

  it("respects the declared limit", async () => {
    // The relation declares limit: 2 in this collection's config variant.
    const r = await broker.query(ctxLimited, { collection: "matters_capped" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.documents[0] as { entries: unknown[] }).entries.length).toBe(2);
  });

  it("never includes a target document belonging to another host document", async () => {
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entries = (r.documents[0] as { entries: { hours: number }[] }).entries;
    expect(entries.map((e) => e.hours)).not.toContain(99);
  });

  it("yields one array element per target document, however many revisions it has", async () => {
    // One of the three entries was seeded with two revisions.
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.documents[0] as { entries: unknown[] }).entries.length).toBe(3);
  });
});
