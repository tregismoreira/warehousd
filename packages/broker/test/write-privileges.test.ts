import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, withWorkspace } from "../src/index";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";

let p: Provisioned, admin: Pool, liveWrite: Pool, liveRead: Pool;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  synthetic: { documents_per_collection: {} },
  collections: {
    pages: {
      description: "d",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
        body: { type: "text", posture: "allow" },
      },
    },
  },
});

beforeAll(async () => {
  p = await provision("write-privileges");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  liveWrite = testPool({ connectionString: p.urls.liveWrite! });
  liveRead = testPool({ connectionString: p.urls.live });
}, 60_000);
afterAll(async () => {
  await admin.end();
  await liveWrite.end();
  await liveRead.end();
  await p.end();
});

const asWorkspace = (pool: Pool, workspaceId: string, sql: string, params: unknown[] = []) =>
  withWorkspace(pool, workspaceId, (c) => c.query(sql, params));

describe("warehousd_live_write privileges", () => {
  it("can INSERT into a data_live base table", async () => {
    await expect(
      asWorkspace(
        liveWrite,
        "default",
        `insert into data_live.pages (workspace_id, id, title, _rev_seq, _rev_by, _rev_op, _rev_status, _rev_fields)
       values ('default', gen_random_uuid(), 'Test', 1, 'user1', 'create', 'approved', '{}')`,
      ),
    ).resolves.toBeDefined();
  });

  it("cannot UPDATE a data column — Postgres refuses the attempt", async () => {
    // First insert a row
    await asWorkspace(
      liveWrite,
      "default",
      `insert into data_live.pages (workspace_id, id, title, _rev_seq, _rev_by, _rev_op, _rev_status, _rev_fields)
       values ('default', gen_random_uuid(), 'Original', 1, 'user1', 'create', 'approved', '{}')`,
    );
    // Try to update data column
    await expect(
      asWorkspace(liveWrite, "default", `update data_live.pages set title = 'Modified'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("can UPDATE _current and _rev_status promotion columns", async () => {
    const id = (
      await asWorkspace(
        liveWrite,
        "default",
        `insert into data_live.pages (workspace_id, id, title, _rev_seq, _rev_by, _rev_op, _rev_status, _rev_fields) values ('default', gen_random_uuid(), 'Test2', 1, 'user1', 'create', 'approved', '{}') returning id`,
      )
    ).rows[0].id;
    await expect(
      asWorkspace(
        liveWrite,
        "default",
        `update data_live.pages set _current = true, _rev_status = 'approved' where id = $1`,
        [id],
      ),
    ).resolves.toBeDefined();
  });

  it("cannot DELETE from the table — no delete privilege granted", async () => {
    await expect(asWorkspace(liveWrite, "default", `delete from data_live.pages`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("the partial unique index rejects a second concurrent promotion", async () => {
    const id = (
      await asWorkspace(
        liveWrite,
        "default",
        `insert into data_live.pages (workspace_id, id, title, _rev_seq, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', gen_random_uuid(), 'Test3', 1, 'user1', 'create', 'approved', '{}', true) returning id`,
      )
    ).rows[0].id;
    // Try to insert another _current row for the same document id
    await expect(
      asWorkspace(
        liveWrite,
        "default",
        `insert into data_live.pages (workspace_id, id, title, _rev_seq, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', $1, 'Test3b', 2, 'user2', 'update', 'approved', '{}', true)`,
        [id],
      ),
    ).rejects.toThrow(/unique constraint/i);
  });

  it("can SELECT from the base table (for concurrency checks and merges)", async () => {
    await expect(
      asWorkspace(liveWrite, "default", `select id from data_live.pages limit 1`),
    ).resolves.toBeDefined();
  });

  it("RLS confines SELECT to the current workspace", async () => {
    // Use a unique marker to identify rows from this test
    const marker = `rls_test_${Date.now()}`;
    // Insert one row in default, one in other workspace
    await asWorkspace(
      liveWrite,
      "default",
      `insert into data_live.pages (workspace_id, id, title, _rev_seq, _rev_by, _rev_op, _rev_status, _rev_fields)
       values ('default', gen_random_uuid(), $1, 1, 'user1', 'create', 'approved', '{}')`,
      [marker],
    );
    await asWorkspace(
      liveWrite,
      "other",
      `insert into data_live.pages (workspace_id, id, title, _rev_seq, _rev_by, _rev_op, _rev_status, _rev_fields)
       values ('other', gen_random_uuid(), $1, 1, 'user1', 'create', 'approved', '{}')`,
      [marker],
    );
    // Select while in default workspace context
    const rows = await asWorkspace(
      liveWrite,
      "default",
      `select count(*)::int as n from data_live.pages where title = $1`,
      [marker],
    );
    expect(rows.rows[0].n).toBe(1); // Only sees default workspace rows
  });
});

describe("the read roles remain unchanged", () => {
  it("warehousd_live still cannot write", async () => {
    await expect(
      liveRead.query(
        `insert into data_live.pages (id, workspace_id, title) values (gen_random_uuid(), 'default', 'x')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("warehousd_live can only select from views, not base tables", async () => {
    await expect(liveRead.query(`select * from data_live.pages limit 1`)).rejects.toThrow(
      /permission denied/i,
    );
    // But the view should work (with workspace context)
    await withWorkspace(liveRead, "default", (c) =>
      c.query(`select * from data_live.v_pages limit 1`),
    );
  });
});

describe("no DELETE privilege anywhere", () => {
  it("information_schema confirms no DELETE on data_live CONTENT tables for write role", async () => {
    const privs = await admin.query<{ table_name: string }>(
      `select table_name from information_schema.table_privileges
       where table_schema='data_live' and grantee='warehousd_live_write' and privilege_type='DELETE'`,
    );
    // `_acl` is the single, deliberate exception, and the assertion names it rather than
    // excluding it silently. An ACL is not content: it has no revision model and nothing
    // references it, so removing the row is the only way to make a restricted document public
    // again — a tombstone would force "no principals" and "no row" to mean different things, and
    // they do not. Everything holding actual document data stays DELETE-free, which is what makes
    // immutability a privilege rather than a code path. See grantAclWriteDDL in apply/ddl.ts.
    expect(
      privs.rows.map((r) => r.table_name),
      "only _acl may be deletable by the write role",
    ).toEqual(["_acl"]);
  });
});
