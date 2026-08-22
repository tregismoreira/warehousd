import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";

// Membership and the ACL-management flag are both per-workspace. An admin (or a
// can-manage-acl client) of workspace A must not carry either into workspace B — `mayManage`
// (acl/manage.ts) looks the caller up scoped to `ctx.workspaceId`, and this is the test that
// would fail if it looked the caller up by id alone.

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
      },
    },
  },
});

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
// `_acl` carries no FK to the collection's base table (see aclTableDDL in apply/ddl.ts), so
// getDocumentAcl/setDocumentAcl need no real document behind this id — only the collection has
// to be `acl: true` in config, which `cfg` above already is.
const docId = "11111111-1111-1111-1111-111111111111";

beforeAll(async () => {
  p = await provision("workspace-acl");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);

  await admin.query(
    `create table if not exists app."user" (
       id text primary key, role text, "workspaceId" text not null default 'default')`,
  );

  await admin.query(
    `insert into app.workspaces (id, name) values ('a', 'A'), ('b', 'B') on conflict do nothing`,
  );

  // admin-a is admin in workspace 'a' only.
  await admin.query(
    `insert into app."user" (id, role, "workspaceId") values ('admin-a','admin','a')`,
  );
  await admin.query(
    `insert into app.workspace_members (workspace_id, user_id, role) values ('a','admin-a','admin')`,
  );

  // The client can manage ACLs in 'a' only.
  await admin.query(
    `insert into app.client_policies (client_id, display_name, workspace_id, can_manage_acl)
     values ('acl-client','ACL client','a',true)`,
  );

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

describe("ACL management does not cross the workspace boundary", () => {
  it("an admin of A cannot getAcl on a document scoped to B", async () => {
    const r = await broker.getDocumentAcl(
      makeCtx({ userId: "admin-a", workspaceId: "b" }),
      { kind: "console" },
      { collection: "content", id: docId },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("acl_denied");
  });

  it("an admin of A cannot setAcl on a document scoped to B", async () => {
    const r = await broker.setDocumentAcl(
      makeCtx({ userId: "admin-a", workspaceId: "b" }),
      { kind: "console" },
      { collection: "content", id: docId, principals: ["user:admin-a"] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("acl_denied");
  });

  it("an admin of A succeeds when scoped to A", async () => {
    const r = await broker.getDocumentAcl(
      makeCtx({ userId: "admin-a", workspaceId: "a" }),
      { kind: "console" },
      { collection: "content", id: docId },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("a can_manage_acl client in A does not carry the flag into B", async () => {
    const r = await broker.getDocumentAcl(
      makeCtx({ userId: "admin-a", workspaceId: "b" }),
      { kind: "client", clientId: "acl-client" },
      { collection: "content", id: docId },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("acl_denied");
  });

  it("the same client succeeds when scoped to A", async () => {
    const r = await broker.getDocumentAcl(
      makeCtx({ userId: "admin-a", workspaceId: "a" }),
      { kind: "client", clientId: "acl-client" },
      { collection: "content", id: docId },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
