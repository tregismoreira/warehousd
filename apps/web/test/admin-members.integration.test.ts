import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;
let harborDir: string;
let enabledDir: string;
let previousProjectDir: string | undefined;

beforeAll(async () => {
  db = await setupWebDbWithData("adminmembers");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");

  harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
  enabledDir = mkdtempSync(join(tmpdir(), "wh-admin-members-"));
  cpSync(harborDir, enabledDir, { recursive: true });
  writeFileSync(join(enabledDir, "warehousd.local.yml"), `workspaces: { enabled: true }\n`);

  previousProjectDir = process.env.WAREHOUSD_PROJECT_DIR;
  process.env.WAREHOUSD_PROJECT_DIR = enabledDir;
}, 60_000);

afterAll(async () => {
  process.env.WAREHOUSD_PROJECT_DIR = previousProjectDir;
  await db?.end();
  rmSync(enabledDir, { recursive: true, force: true });
});

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("GET /api/admin/members", () => {
  it("403s for a manager", async () => {
    const { GET } = await import("../app/api/admin/members/route");
    const res = await GET(req("/api/admin/members", { cookie: marcusCookie }) as any);
    expect(res.status).toBe(403);
  });

  it("lists the three personas with their workspace role", async () => {
    const { GET } = await import("../app/api/admin/members/route");
    const res = await GET(req("/api/admin/members", { cookie: anaCookie }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members.find((m: any) => m.userId === "ana").role).toBe("admin");
    expect(body.members.find((m: any) => m.userId === "mia").role).toBe("member");
  });
});

describe("POST /api/admin/members", () => {
  it("403s for a manager", async () => {
    const { POST } = await import("../app/api/admin/members/route");
    const res = await POST(
      req("/api/admin/members", {
        method: "POST",
        cookie: marcusCookie,
        body: { email: "mia@harbor.demo", role: "admin" },
      }) as any,
    );
    expect(res.status).toBe(403);
  });

  it("404s for an email with no account", async () => {
    const { POST } = await import("../app/api/admin/members/route");
    const res = await POST(
      req("/api/admin/members", {
        method: "POST",
        cookie: anaCookie,
        body: { email: "nobody@harbor.demo", role: "member" },
      }) as any,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_email");
  });

  it("changes an existing member's role in this workspace", async () => {
    const { POST } = await import("../app/api/admin/members/route");
    const res = await POST(
      req("/api/admin/members", {
        method: "POST",
        cookie: anaCookie,
        body: { email: "mia@harbor.demo", role: "manager" },
      }) as any,
    );
    expect(res.status).toBe(201);
    const role = await getAppPool().query(
      `select role from app.workspace_members where workspace_id='default' and user_id='mia'`,
    );
    expect(role.rows[0].role).toBe("manager");

    // restore, so later tests see the seeded shape
    await getAppPool().query(
      `update app.workspace_members set role='member' where workspace_id='default' and user_id='mia'`,
    );
  });

  // A role change away from admin can strand a workspace the same way removing its last admin
  // does — this is the same guard as DELETE's LastAdminRemoval, reached through the other door.
  // Fails without the fix: setMember would happily write 'member' over the workspace's only
  // admin, and nothing else in this route would have caught it.
  it("refuses to demote the last admin, leaving their role in place", async () => {
    const { POST } = await import("../app/api/admin/members/route");
    const res = await POST(
      req("/api/admin/members", {
        method: "POST",
        cookie: anaCookie,
        body: { email: "ana@harbor.demo", role: "member" },
      }) as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot_demote_last_admin");
    const role = await getAppPool().query(
      `select role from app.workspace_members where workspace_id='default' and user_id='ana'`,
    );
    expect(role.rows[0].role).toBe("admin");
  });
});

describe("DELETE /api/admin/members", () => {
  it("403s for a manager", async () => {
    const { DELETE } = await import("../app/api/admin/members/route");
    const res = await DELETE(
      req("/api/admin/members?userId=mia", { method: "DELETE", cookie: marcusCookie }) as any,
    );
    expect(res.status).toBe(403);
  });

  it("lets an admin leave a workspace that has another admin", async () => {
    // Promote mia to admin so ana is not the only one, then ana removes herself.
    const { POST } = await import("../app/api/admin/members/route");
    await POST(
      req("/api/admin/members", {
        method: "POST",
        cookie: anaCookie,
        body: { email: "mia@harbor.demo", role: "admin" },
      }) as any,
    );
    const { DELETE } = await import("../app/api/admin/members/route");
    const res = await DELETE(
      req("/api/admin/members?userId=ana", { method: "DELETE", cookie: miaCookie }) as any,
    );
    expect(res.status).toBe(204);

    // restore: re-add ana as admin for the tests after this one.
    await getAppPool().query(
      `insert into app.workspace_members (workspace_id, user_id, role) values ('default','ana','admin')
       on conflict (workspace_id, user_id) do update set role='admin'`,
    );
  });

  it("refuses to remove the last admin, leaving the row in place", async () => {
    // mia is the workspace's only admin at this point (the previous test put ana back, so
    // demote her to manager first — the case this guards is a workspace with exactly one admin
    // trying to remove them, and by definition only that admin can be the one making the call).
    const { POST, DELETE } = await import("../app/api/admin/members/route");
    await POST(
      req("/api/admin/members", {
        method: "POST",
        cookie: anaCookie,
        body: { email: "mia@harbor.demo", role: "admin" },
      }) as any,
    );
    await POST(
      req("/api/admin/members", {
        method: "POST",
        cookie: miaCookie,
        body: { email: "ana@harbor.demo", role: "manager" },
      }) as any,
    );

    const res = await DELETE(
      req("/api/admin/members?userId=mia", { method: "DELETE", cookie: miaCookie }) as any,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("last_admin");
    const stillThere = await getAppPool().query(
      `select role from app.workspace_members where workspace_id='default' and user_id='mia'`,
    );
    expect(stillThere.rows[0].role).toBe("admin");

    // restore: ana back to admin for any later test in this file.
    await getAppPool().query(
      `update app.workspace_members set role='admin' where workspace_id='default' and user_id='ana'`,
    );
  });
});

describe("with workspaces.enabled: false", () => {
  it("every method 404s", async () => {
    process.env.WAREHOUSD_PROJECT_DIR = harborDir;
    try {
      const { GET, POST, DELETE } = await import("../app/api/admin/members/route");
      expect((await GET(req("/api/admin/members", { cookie: anaCookie }) as any)).status).toBe(404);
      expect(
        (
          await POST(
            req("/api/admin/members", {
              method: "POST",
              cookie: anaCookie,
              body: { email: "mia@harbor.demo", role: "admin" },
            }) as any,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await DELETE(
            req("/api/admin/members?userId=mia", { method: "DELETE", cookie: anaCookie }) as any,
          )
        ).status,
      ).toBe(404);
    } finally {
      process.env.WAREHOUSD_PROJECT_DIR = enabledDir;
    }
  });
});
