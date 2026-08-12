import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";
import { setMember, removeMember, LastAdminRemoval } from "@warehousd/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("wsmembers");
  const app = getAppPool();
  await app.query(
    `insert into app.workspaces (id, name) values ('w2', 'W2') on conflict do nothing`,
  );
  // Ana is admin in 'default' (the bootstrap backfill) and member in 'w2'.
  await setMember(app, { workspaceId: "w2", userId: "ana", role: "member" });
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

function req(url: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request(`http://localhost:8722${url}`, { headers });
}

describe("requireRole against the active workspace's membership, not the global role", () => {
  it("an admin of default is refused admin on a route with a w2-active session", async () => {
    const app = getAppPool();
    await app.query(`update app.session set "activeWorkspaceId" = 'w2' where "userId" = 'ana'`);
    try {
      const { requireRole } = await import("../lib/authz");
      const guard = await requireRole(req("/admin", anaCookie), "admin");
      expect(guard.ok).toBe(false);
      if (!guard.ok) expect(guard.response.status).toBe(403);
    } finally {
      await app.query(
        `update app.session set "activeWorkspaceId" = 'default' where "userId" = 'ana'`,
      );
    }
  });

  it("a user with no membership in w2 gets 403, not 401", async () => {
    const app = getAppPool();
    await app.query(`update app.session set "activeWorkspaceId" = 'w2' where "userId" = 'mia'`);
    try {
      const { requireSession } = await import("../lib/authz");
      const guard = await requireSession(req("/", miaCookie));
      expect(guard.ok).toBe(false);
      if (!guard.ok) {
        expect(guard.response.status).toBe(403);
        expect(await guard.response.json()).toEqual({ error: "forbidden" });
      }
    } finally {
      await app.query(
        `update app.session set "activeWorkspaceId" = 'default' where "userId" = 'mia'`,
      );
    }
  });
});

describe("setMember / removeMember", () => {
  it("setMember upserts a role change", async () => {
    const app = getAppPool();
    await setMember(app, { workspaceId: "w2", userId: "mia", role: "manager" });
    let r = await app.query(
      `select role from app.workspace_members where workspace_id='w2' and user_id='mia'`,
    );
    expect(r.rows[0]?.role).toBe("manager");

    await setMember(app, { workspaceId: "w2", userId: "mia", role: "member" });
    r = await app.query(
      `select role from app.workspace_members where workspace_id='w2' and user_id='mia'`,
    );
    expect(r.rows[0]?.role).toBe("member");
  });

  it("removeMember returns false for a non-member", async () => {
    const app = getAppPool();
    const removed = await removeMember(app, { workspaceId: "w2", userId: "marcus" });
    expect(removed).toBe(false);
  });

  it("removeMember on the last admin throws LastAdminRemoval and the row survives", async () => {
    const app = getAppPool();
    const before = await app.query(
      `select count(*)::int as n from app.workspace_members where workspace_id='default' and role='admin'`,
    );
    expect(before.rows[0]?.n).toBe(1);

    await expect(removeMember(app, { workspaceId: "default", userId: "ana" })).rejects.toThrow(
      LastAdminRemoval,
    );

    const after = await app.query(
      `select count(*)::int as n from app.workspace_members where workspace_id='default' and role='admin'`,
    );
    expect(after.rows[0]?.n).toBe(1);
  });
});
