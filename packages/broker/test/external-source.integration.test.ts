import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker, type Pools } from "../src/index";
import { ConfigSchema } from "../src/config/schema";
import { EXTERNAL_CANARY, EXTERNAL_UNDECLARED_CANARY } from "./fixtures/canaries";
import { makeCtx } from "./helpers/ctx";
import { captureLogs } from "./helpers/log-capture";

// Connect-in-place, against a real second database.
//
// The "remote" is a second provisioned database in the same cluster, which is what makes this a
// genuine test rather than a mock: the foreign table really does cross a connection, the
// credential really is a user mapping, and `updatable 'false'` really is enforced by Postgres.
//
// The design claim under test is that a foreign table inside data_live needs NO new enforcement
// path — the collection's view, its grant, its field postures and `dataPool` all work on it
// unchanged. So most of this file asserts that the ordinary rules still apply, and the rest
// asserts the two things that are genuinely new: the workspace predicate that replaces RLS, and the
// column set that upstream cannot widen.

// See the note in SourceSchema: `sources[].url` is dialled by the database server, so a test
// pointing one database at another in the same cluster has to use the server's own view of it.
const serverVisibleUrl = (dbName: string) =>
  `postgres://postgres:postgres@127.0.0.1:5432/${dbName}`;

let p: Provisioned, remote: Provisioned;
let admin: Pool, remoteAdmin: Pool, pools: Pools;
let broker: ReturnType<typeof makeBroker>;

const ctx = (userId: string, workspaceId = "default") =>
  makeCtx({ userId, workspaceId, env: "live" as const });

// The remote's own column is `acct_name`; warehousd calls the field `name`. Exercising the
// rename in the happy path means the mapping cannot rot unnoticed.
const cfgFor = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    project: "extsrc",
    server: { port: 1 },
    // The address POSTGRES will dial, not the one this test client uses. The cluster runs in a
    // container publishing 5432 on the host's 54330, and the FDW connection is opened by the
    // server — so from its own perspective the "remote" database is on its loopback at 5432.
    sources: { crm: { type: "postgres", url: serverVisibleUrl(remote.dbName), schema: "public" } },
    collections: {
      accounts: {
        description: "CRM accounts",
        source_ref: { source: "crm", table: "accounts", workspace: "default" },
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          name: { type: "text", posture: "allow", column: "acct_name" },
          tier: { type: "text", posture: "allow" },
          internal_note: { type: "text", posture: "deny" },
          ...(over.fields as object),
        },
      },
    },
  });

beforeAll(async () => {
  remote = await provision("extsrc_remote", { bare: true });
  remoteAdmin = testPool({ connectionString: remote.urls.admin });
  await remoteAdmin.query(
    `
    create table public.accounts (
      id uuid primary key,
      acct_name text,
      tier text,
      internal_note text,
      -- A column warehousd never declares. The point of writing the foreign table's columns out
      -- by hand is that this one is unreachable no matter what a caller asks for.
      secret_margin text);
    insert into public.accounts values
      ('00000000-0000-4000-8000-000000000001', $1, 'gold', 'internal only', $2),
      ('00000000-0000-4000-8000-000000000002', 'Ridgeline', 'silver', 'internal too', $2);
  `
      .replace("$1", `'${EXTERNAL_CANARY}'`)
      .replace(/\$2/g, `'${EXTERNAL_UNDECLARED_CANARY}'`),
  );

  p = await provision("extsrc");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfgFor());
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfgFor());

  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ('mia','accounts',$1,'live','approved')`,
    [["id", "name", "tier"]],
  );
  // Same grant, a different tenant. The remote has no workspace column, so this is the case the
  // constant predicate has to answer.
  await admin.query(`insert into app.workspaces (id, name) values ('other-workspace','Other')`);
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status, workspace_id)
     values ('other','accounts',$1,'live','approved','other-workspace')`,
    [["id", "name", "tier"]],
  );
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await remoteAdmin?.end();
  await pools?.end();
  await p?.end();
  await remote?.end();
});

describe("reading through a foreign table", () => {
  it("returns remote rows through the ordinary query path", async () => {
    const r = await broker.query(ctx("mia"), { collection: "accounts", fields: ["id", "name"] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.documents.map((d) => String(d.name))).toContain(EXTERNAL_CANARY);
  });

  it("maps a remote column name onto the declared field name", async () => {
    // The remote calls it acct_name. Nothing downstream of the foreign table should know that.
    const r = await broker.query(ctx("mia"), { collection: "accounts", fields: ["name"] });
    if (!r.ok) throw new Error("unreachable");
    expect(Object.keys(r.documents[0]!)).toEqual(["name"]);
  });

  it("applies filters, ordering and grants exactly as a local collection does", async () => {
    const r = await broker.query(ctx("mia"), {
      collection: "accounts",
      fields: ["id", "name"],
      filters: [{ field: "tier", op: "eq", value: "gold" }],
      orderBy: { field: "name", dir: "asc" },
    });
    if (!r.ok) throw new Error("unreachable");
    expect(r.documents).toHaveLength(1);
  });

  it("refuses a denied field, the same way and with the same code", async () => {
    const r = await broker.query(ctx("mia"), {
      collection: "accounts",
      fields: ["id", "internal_note"],
    });
    expect(r).toMatchObject({ ok: false, reason: "field_denied" });
  });
});

describe("what upstream cannot reach into", () => {
  it("cannot expose a column warehousd never declared", async () => {
    // secret_margin exists on the remote table and in no warehousd config. Every way of naming
    // it has to fail, and none of them may leak the value.
    for (const intent of [
      { collection: "accounts", fields: ["id", "secret_margin"] },
      {
        collection: "accounts",
        fields: ["id"],
        filters: [{ field: "secret_margin", op: "eq" as const, value: "x" }],
      },
      {
        collection: "accounts",
        fields: ["id"],
        orderBy: { field: "secret_margin", dir: "asc" as const },
      },
    ]) {
      const r = await broker.query(ctx("mia"), intent);
      expect(r).toMatchObject({ ok: false, reason: "unknown_field" });
      expect(JSON.stringify(r)).not.toContain(EXTERNAL_UNDECLARED_CANARY);
    }
  });

  it("keeps it out of the foreign table itself, not just out of the answer", async () => {
    // The strongest form: the column is absent from the local schema entirely, so there is no
    // query — broker-built or otherwise — that could reach it through this database.
    const cols = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema='data_live' and table_name='_ext_accounts'`,
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
      "id",
      "internal_note",
      "name",
      "tier",
    ]);
  });

  it("does not widen when a column is added upstream", async () => {
    await remoteAdmin.query(`alter table public.accounts add column added_later text`);
    try {
      await applyConfig(admin, cfgFor());
      const r = await broker.query(ctx("mia"), {
        collection: "accounts",
        fields: ["id", "added_later"],
      });
      expect(r).toMatchObject({ ok: false, reason: "unknown_field" });
    } finally {
      await remoteAdmin.query(`alter table public.accounts drop column added_later`);
      await applyConfig(admin, cfgFor());
    }
  });
});

describe("tenant isolation without RLS", () => {
  it("returns nothing to a context whose workspace the source is not bound to", async () => {
    // A foreign table cannot carry an RLS policy, so the view's constant predicate is the only
    // wall. This is the assertion that it is actually load-bearing.
    const r = await broker.query(ctx("other", "other-workspace"), {
      collection: "accounts",
      fields: ["id", "name"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.documents).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain(EXTERNAL_CANARY);
  });

  it("fails closed when no workspace is in scope at all", async () => {
    const direct = testPool({ connectionString: p.urls.live });
    try {
      const r = await direct.query(`select * from data_live.v_accounts`);
      expect(r.rowCount).toBe(0);
    } finally {
      await direct.end();
    }
  });
});

describe("read-only, enforced by the database", () => {
  it("refuses a write through the broker", async () => {
    const r = await broker.mutate(ctx("mia"), {
      collection: "accounts",
      op: "create",
      values: { id: "00000000-0000-4000-8000-000000000009", name: "New" },
    });
    expect(r).toMatchObject({ ok: false, reason: "not_writable" });
  });

  it("refuses a write even as the owner, because the foreign table is not updatable", async () => {
    // The broker refusal above is the readable answer; this is the wall behind it. A future
    // change that made `mutate` permissive would still not be able to write.
    await expect(
      admin.query(
        `insert into data_live."_ext_accounts" (id, name, tier) values (gen_random_uuid(),'x','y')`,
      ),
      // Postgres's own words: "foreign table ... does not allow inserts". Asserted verbatim
      // rather than loosely, because the whole point is that the DATABASE refuses this.
    ).rejects.toThrow(/does not allow inserts/i);
  });

  it("gives the read role the view and nothing else", async () => {
    const live = testPool({ connectionString: p.urls.live });
    try {
      await expect(live.query(`select 1 from data_live."_ext_accounts" limit 1`)).rejects.toThrow(
        /permission denied/i,
      );
      await live.query(`select set_config('warehousd.workspace_id','default',false)`);
      await expect(live.query(`select 1 from data_live.v_accounts limit 1`)).resolves.toBeDefined();
    } finally {
      await live.end();
    }
  });
});

describe("env parity", () => {
  it("gives dev an ordinary local table, so a developer never touches the remote", async () => {
    const t = await admin.query(
      `select table_name from information_schema.tables
       where table_schema='data_synth' and table_name='accounts'`,
    );
    expect(t.rowCount).toBe(1);
    const foreign = await admin.query(
      `select 1 from information_schema.foreign_tables
       where foreign_table_schema='data_synth'`,
    );
    expect(foreign.rowCount).toBe(0);
  });
});

describe("when the config and the remote disagree", () => {
  it("fails the apply, naming the collection and the source", async () => {
    // A column declared in the YAML that the remote does not have. Catching this at apply time
    // is the difference between an operator seeing the problem and a governed query returning
    // internal_error for a reason nobody can see.
    const wrong = cfgFor({ fields: { nonexistent: { type: "text", posture: "allow" } } });
    await expect(applyConfig(admin, wrong)).rejects.toThrow(
      /does not match its source \(crm\.accounts\)/i,
    );
    await applyConfig(admin, cfgFor());
  });

  it("reports an unreachable remote as internal_error, with no driver text for the caller", async () => {
    const logs = captureLogs();
    try {
      await remoteAdmin.query(`alter table public.accounts rename to accounts_moved`);
      const r = await broker.query(ctx("mia"), { collection: "accounts", fields: ["id", "name"] });
      expect(r).toMatchObject({ ok: false, reason: "internal_error" });
      // The caller learns nothing about the remote's shape, name or host.
      const payload = JSON.stringify(r);
      expect(payload).not.toMatch(/accounts_moved|relation|does not exist|127\.0\.0\.1/i);
    } finally {
      await remoteAdmin.query(`alter table public.accounts_moved rename to accounts`);
      logs.restore();
    }
  });
});
