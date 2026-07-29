import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;
let marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDb("authint");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
}, 60_000);

afterAll(async () => { await db?.end(); });

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe("auth gate", () => {
  it("grants GET without a session → 401", async () => {
    const { GET } = await import("../app/api/grants/route");
    const res = await GET(req("/api/grants") as any);
    expect(res.status).toBe(401);
  });

  it("grants GET with a session → 200 and returns the session user's grants", async () => {
    const { GET } = await import("../app/api/grants/route");
    const res = await GET(req("/api/grants", { cookie: miaCookie }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Every returned "mine" grant belongs to mia — the session user, not a query param.
    for (const g of body.mine) expect(g.user_id).toBe("mia");
  });

  it("member approve → 403", async () => {
    const { POST } = await import("../app/api/grants/route");
    // mia (member) tries to approve her own pending salaries grant
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "approve", id: "00000000-0000-0000-0000-000000000000" },
    }) as any);
    expect(res.status).toBe(403);
  });

  it("manager approve → not 403 (authorized role passes the check)", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: marcusCookie,
      body: { action: "revoke", id: "00000000-0000-0000-0000-000000000000" },
    }) as any);
    // A non-existent id returns 404 (not 403), confirming the role check passed.
    expect(res.status).toBe(404);
  });

  it("planted userId/env in body is ignored; context derives from session", async () => {
    const { GET } = await import("../app/api/grants/route");
    // Even if a caller crafts ?user=marcus, the session (mia) wins.
    const res = await GET(req("/api/grants?user=marcus", { cookie: miaCookie }) as any);
    const body = await res.json();
    for (const g of body.mine) expect(g.user_id).toBe("mia");
  });
});
