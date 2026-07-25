import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("adminregen");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/api/admin/regen-synth", {
    method: "POST", headers, body: JSON.stringify(body ?? {}),
  });
}

describe("POST /api/admin/regen-synth", () => {
  it("403s for a manager", async () => {
    const { POST } = await import("../app/api/admin/regen-synth/route");
    expect((await POST(req(marcusCookie) as any)).status).toBe(403);
  });

  it("regenerates and reports which collections it touched", async () => {
    const { POST } = await import("../app/api/admin/regen-synth/route");
    const res = await POST(req(anaCookie, { seed: 11 }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.collections).toContain("people");
    expect(body.collections).not.toContain("policies");
  });

  it("writes one audit event per regenerated collection", async () => {
    const before = await getAppPool().query(
      `select count(*)::int as n from app.audit_events where intent->>'op' = 'regen_synth'`);
    const { POST } = await import("../app/api/admin/regen-synth/route");
    await POST(req(anaCookie, { seed: 12 }) as any);
    const after = await getAppPool().query(
      `select count(*)::int as n from app.audit_events where intent->>'op' = 'regen_synth'`);
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);

    const one = await getAppPool().query(
      `select user_id, env, outcome from app.audit_events
       where intent->>'op' = 'regen_synth' order by at desc limit 1`);
    expect(one.rows[0]).toMatchObject({ user_id: "ana", env: "dev", outcome: "allowed" });
  });

  it("leaves data_live untouched even when the caller's env cookie says live", async () => {
    const app = getAppPool();
    const before = await app.query(`select count(*)::int as n from data_live.people`);
    const { POST } = await import("../app/api/admin/regen-synth/route");
    const r = new Request("http://localhost:8722/api/admin/regen-synth", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${anaCookie}; wh_env=live` },
      body: JSON.stringify({}),
    });
    expect((await POST(r as any)).status).toBe(200);
    const after = await app.query(`select count(*)::int as n from data_live.people`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("rejects a non-numeric seed", async () => {
    const { POST } = await import("../app/api/admin/regen-synth/route");
    const res = await POST(req(anaCookie, { seed: "banana" }) as any);
    expect(res.status).toBe(400);
  });
});
