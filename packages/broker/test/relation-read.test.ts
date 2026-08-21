import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { makeCtx } from "./helpers/ctx";
import { captureLogs } from "./helpers/log-capture";
import { ConfigSchema } from "../src/config/schema";
import { applyConfig, makeBroker, migrateApp, createPools } from "../src/index";

const CONFIG = ConfigSchema.parse({
  project: "t",
  collections: {
    matters: {
      description: "Matters",
      // writable so "refuses field_not_writable when a relation is written to" reaches the
      // per-field relation check rather than refusing not_writable first.
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        // searchable so "refuses invalid_intent when a relation is named in a search" exercises
        // the relation-in-search refusal rather than "this collection cannot be searched at all";
        // write:allow so the collection satisfies writable/requires-writable-field below.
        title: {
          type: "text",
          posture: { read: "allow", write: "allow" },
          searchable: true,
        },
        client_id: { type: "uuid", posture: "allow", fk: "clients.id" },
        client: {
          posture: "allow",
          relation: {
            collection: "clients",
            on: "client_id",
            select: {
              name: { posture: "allow" },
              billing_email: {
                posture: { read: "mask", write: "deny" },
                mask: { transform: "domain" },
              },
              // `credit_notes` is deliberately NOT selected — it must never appear.
            },
          },
        },
      },
    },
    clients: {
      description: "Clients",
      acl: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        name: { type: "text", posture: "allow" },
        billing_email: { type: "text", posture: "allow" },
        credit_notes: { type: "text", posture: "deny" },
      },
    },
  },
});

const M1 = "aaaaaaaa-0000-4000-8000-000000000001";
const M2 = "aaaaaaaa-0000-4000-8000-000000000002";
const C1 = "bbbbbbbb-0000-4000-8000-000000000001";
const C2 = "bbbbbbbb-0000-4000-8000-000000000002";

describe("to-one relations", () => {
  let p: Provisioned;
  let app: Pool;
  let pools: ReturnType<typeof createPools>;
  let broker: ReturnType<typeof makeBroker>;
  const ctx = makeCtx({ userId: "alice" });

  async function seedMatter(id: string, title: string, clientId: string) {
    await app.query(
      `insert into data_synth.matters
         (_rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _rev_base,
          _current, workspace_id, id, title, client_id)
       values (gen_random_uuid(), 1, now(), 'seed', 'create', 'approved', array[]::text[], null,
          true, 'default', $1, $2, $3)`,
      [id, title, clientId],
    );
  }

  async function seedClient(
    id: string,
    seq: number,
    name: string,
    current: boolean,
    workspace = "default",
  ) {
    await app.query(
      `insert into data_synth.clients
         (_rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _rev_base,
          _current, workspace_id, id, name, billing_email, credit_notes)
       values (gen_random_uuid(), $1, now(), 'seed', 'create', 'approved', array[]::text[], null,
          $2, $3, $4, $5, 'ap@acme.example', 'CREDIT_CANARY')`,
      [seq, current, workspace, id, name],
    );
  }

  beforeAll(async () => {
    p = await provision("relation-read");
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
         array['id','title','client_id','client'], array['read','update'], 'direct', 'dev', 'approved',
         now(), now())`,
    );

    await seedClient(C1, 1, "Acme", true);
    // A SECOND revision of the same client. The relation must still yield one document.
    await app.query(`update data_synth.clients set _current = false where id = $1`, [C1]);
    await seedClient(C1, 2, "Acme Renamed", true);
    await seedMatter(M1, "First matter", C1);

    // A client in another workspace, and a matter pointing at it.
    await seedClient(C2, 1, "OtherTenant", true, "other");
    await seedMatter(M2, "Second matter", C2);
  }, 120_000);

  afterAll(async () => {
    await pools.end?.();
    await app.end();
    await p.end();
  });

  it("nests the selected target fields as an object", async () => {
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = r.documents[0] as Record<string, unknown>;
    expect(doc.client).toMatchObject({ name: "Acme Renamed" });
  });

  it("omits a target field the host did not select, and never logs it", async () => {
    const logs = captureLogs();
    try {
      const r = await broker.query(ctx, {
        collection: "matters",
        filters: [{ field: "id", op: "eq", value: M1 }],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(JSON.stringify(r)).not.toContain("credit_notes");
      expect(JSON.stringify(r)).not.toContain("CREDIT_CANARY");
    } finally {
      expect(logs.text()).not.toContain("CREDIT_CANARY");
      logs.restore();
    }
  });

  it("masks a masked sub-field", async () => {
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const client = (r.documents[0] as { client: { billing_email: unknown } }).client;
    expect(client.billing_email).not.toBe("ap@acme.example");
  });

  it("yields ONE document when the target has more than one revision", async () => {
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.documents.length).toBe(1);
  });

  it("resolves to null for a target in another workspace", async () => {
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M2 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.documents[0] as Record<string, unknown>).client).toBeNull();
  });

  it("resolves to null for an ACL-restricted target the caller is not a principal of", async () => {
    await app.query(
      `insert into data_synth."_acl" (workspace_id, collection, document_id, principals, updated_at, updated_by)
       values ('default', 'clients', $1, array['user:bob'], now(), 'admin')
       on conflict (workspace_id, collection, document_id) do update set principals = excluded.principals`,
      [C1],
    );
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.documents[0] as Record<string, unknown>).client).toBeNull();
    // and the host document itself is still returned — the relation is null, not the row absent
    expect(r.documents.length).toBe(1);
    await app.query(`delete from data_synth."_acl" where document_id = $1`, [C1]);
  });

  it("binds the host's fk to the outer document even when the target has a field of the same name", async () => {
    // `clients` has no `client_id`, so this asserts the alias exists rather than the collision.
    // The regression is that an unqualified reference must resolve to `base`.
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.documents[0] as { client: { name: unknown } }).client.name).toBe("Acme Renamed");
  });

  it("is absent for a caller whose grant does not carry the relation field", async () => {
    await app.query(
      `update app.grants set allowed_fields = array['id','title'] where user_id = 'alice'`,
    );
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "id", op: "eq", value: M1 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.documents[0] as object)).not.toContain("client");
    await app.query(
      `update app.grants set allowed_fields = array['id','title','client_id','client'] where user_id = 'alice'`,
    );
  });

  // getDocument is the headline case for a relation — "a matter with its client nested, rather
  // than an id to resolve in a second call" — and it reaches buildSelect through its own call
  // site, with its own relation options. A regression there would leave query() passing and the
  // single-document read returning an unexpanded column or erroring.
  it("expands a relation on getDocument, not only on query", async () => {
    const r = await broker.getDocument(ctx, { collection: "matters", id: M1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = r.document as Record<string, unknown>;
    expect(doc.client).toMatchObject({ name: "Acme Renamed" });
    // the same three properties query() gets: unselected target fields absent, masked one masked
    expect(JSON.stringify(r)).not.toContain("credit_notes");
    expect(JSON.stringify(r)).not.toContain("CREDIT_CANARY");
    expect((doc.client as Record<string, unknown>).billing_email).not.toBe("ap@acme.example");
  });

  it("resolves a relation to null on getDocument across a workspace boundary", async () => {
    const r = await broker.getDocument(ctx, { collection: "matters", id: M2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.document as Record<string, unknown>).client).toBeNull();
  });

  it("refuses invalid_intent when a relation is filtered on", async () => {
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "client", op: "eq", value: "x" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_intent");
  });

  it("refuses invalid_intent when a relation is ordered, grouped or aggregated by", async () => {
    for (const intent of [
      { collection: "matters", orderBy: { field: "client", dir: "asc" as const } },
      { collection: "matters", groupBy: ["client"] },
      { collection: "matters", aggregate: [{ fn: "count" as const, field: "client" }] },
    ]) {
      const r = await broker.query(ctx, intent);
      expect(r.ok, JSON.stringify(intent)).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_intent");
    }
  });

  it("refuses invalid_intent when a relation is named in a search, in every mode", async () => {
    for (const mode of ["text", "semantic", "hybrid"] as const) {
      const r = await broker.searchDocuments(ctx, {
        collection: "matters",
        q: "acme",
        fields: ["client"],
        mode,
      });
      expect(r.ok, mode).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_intent");
    }
  });

  it("refuses field_not_writable when a relation is written to", async () => {
    const r = await broker.mutate(ctx, {
      op: "update",
      collection: "matters",
      id: M1,
      values: { client: { name: "nope" } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("field_not_writable");
  });
});
