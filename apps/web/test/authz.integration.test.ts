import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string, marcusCookie: string, anaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("authz");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/api/whatever", { headers });
}

describe("atLeast", () => {
  it("admin satisfies every requirement", async () => {
    const { atLeast } = await import("../lib/authz");
    expect(atLeast("admin", "admin")).toBe(true);
    expect(atLeast("admin", "manager")).toBe(true);
    expect(atLeast("admin", "member")).toBe(true);
  });
  it("manager satisfies manager and member but not admin", async () => {
    const { atLeast } = await import("../lib/authz");
    expect(atLeast("manager", "admin")).toBe(false);
    expect(atLeast("manager", "manager")).toBe(true);
    expect(atLeast("manager", "member")).toBe(true);
  });
  it("member satisfies only member", async () => {
    const { atLeast } = await import("../lib/authz");
    expect(atLeast("member", "admin")).toBe(false);
    expect(atLeast("member", "manager")).toBe(false);
    expect(atLeast("member", "member")).toBe(true);
  });
});

describe("requireSession", () => {
  it("401s with the exact unauthenticated shape when there is no cookie", async () => {
    const { requireSession } = await import("../lib/authz");
    const r = await requireSession(req());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toEqual({ error: "unauthenticated" });
  });

  it("returns the session user for any signed-in role", async () => {
    const { requireSession } = await import("../lib/authz");
    const r = await requireSession(req(miaCookie));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.user.id).toBe("mia");
    expect(r.user.role).toBe("member");
  });
});

describe("requireRole", () => {
  it("401s without a session before it ever considers the role", async () => {
    const { requireRole } = await import("../lib/authz");
    const r = await requireRole(req(), "member");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
  });

  it("403s with the exact forbidden shape when the role is too low", async () => {
    const { requireRole } = await import("../lib/authz");
    const r = await requireRole(req(miaCookie), "manager");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(403);
    expect(await r.response.json()).toEqual({ error: "forbidden" });
  });

  it("admits a manager to a manager-gated route", async () => {
    const { requireRole } = await import("../lib/authz");
    const r = await requireRole(req(marcusCookie), "manager");
    expect(r.ok).toBe(true);
  });

  it("admits an admin to a manager-gated route (hierarchy)", async () => {
    const { requireRole } = await import("../lib/authz");
    const r = await requireRole(req(anaCookie), "manager");
    expect(r.ok).toBe(true);
  });

  it("refuses a manager on an admin-gated route", async () => {
    const { requireRole } = await import("../lib/authz");
    const r = await requireRole(req(marcusCookie), "admin");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(403);
  });
});
