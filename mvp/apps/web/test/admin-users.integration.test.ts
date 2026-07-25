import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("adminusers");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET", headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}
const params = (userId: string) => ({ params: Promise.resolve({ userId }) });
const roleOf = async (id: string) =>
  (await getAppPool().query(`select role from app."user" where id=$1`, [id])).rows[0].role;

describe("GET /api/admin/users", () => {
  it("403s for a manager", async () => {
    const { GET } = await import("../app/api/admin/users/route");
    expect((await GET(req("/api/admin/users", { cookie: marcusCookie }) as any)).status).toBe(403);
  });

  it("lists the three personas with their roles, and no password material", async () => {
    const { GET } = await import("../app/api/admin/users/route");
    const res = await GET(req("/api/admin/users", { cookie: anaCookie }) as any);
    const raw = await res.text();
    expect(raw).not.toMatch(/password/i);
    const body = JSON.parse(raw);
    expect(body.users.find((u: any) => u.id === "ana").role).toBe("admin");
    expect(body.users.find((u: any) => u.id === "mia").role).toBe("member");
  });
});

describe("PATCH /api/admin/users/[userId]", () => {
  it("403s for a manager", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const res = await PATCH(
      req("/api/admin/users/mia", { method: "PATCH", cookie: marcusCookie, body: { role: "admin" } }) as any,
      params("mia"));
    expect(res.status).toBe(403);
    expect(await roleOf("mia")).toBe("member");
  });

  it("promotes a member to manager", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const res = await PATCH(
      req("/api/admin/users/mia", { method: "PATCH", cookie: anaCookie, body: { role: "manager" } }) as any,
      params("mia"));
    expect(res.status).toBe(200);
    expect(await roleOf("mia")).toBe("manager");
  });

  it("rejects a role outside the three", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const res = await PATCH(
      req("/api/admin/users/mia", { method: "PATCH", cookie: anaCookie, body: { role: "superuser" } }) as any,
      params("mia"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_role");
  });

  it("refuses to let an admin demote themselves", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const res = await PATCH(
      req("/api/admin/users/ana", { method: "PATCH", cookie: anaCookie, body: { role: "member" } }) as any,
      params("ana"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot_demote_self");
    expect(await roleOf("ana")).toBe("admin");
  });

  it("refuses to demote the last admin", async () => {
    // Promote Mia so there are two admins, demote Ana (allowed), then try to demote Mia.
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    await PATCH(req("/api/admin/users/mia", { method: "PATCH", cookie: anaCookie, body: { role: "admin" } }) as any, params("mia"));
    const miaAdminCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
    await PATCH(req("/api/admin/users/ana", { method: "PATCH", cookie: miaAdminCookie, body: { role: "member" } }) as any, params("ana"));
    expect(await roleOf("ana")).toBe("member");

    const res = await PATCH(
      req("/api/admin/users/mia", { method: "PATCH", cookie: miaAdminCookie, body: { role: "member" } }) as any,
      params("mia"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot_demote_self");
  });

  it("404s on an unknown user", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const miaAdminCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
    const res = await PATCH(
      req("/api/admin/users/nobody", { method: "PATCH", cookie: miaAdminCookie, body: { role: "member" } }) as any,
      params("nobody"));
    expect(res.status).toBe(404);
  });
});
