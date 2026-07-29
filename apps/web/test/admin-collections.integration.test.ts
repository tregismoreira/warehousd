import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";
import { applyStatus } from "../lib/apply-status";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("admincolls");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/api/admin/collections", { headers });
}

describe("applyStatus", () => {
  it("reports not_applied when nothing is recorded", () => {
    expect(applyStatus({ a: 1 }, null)).toBe("not_applied");
  });
  it("reports applied when the two configs match regardless of key order", () => {
    expect(applyStatus({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe("applied");
  });
  it("reports drifted when a posture changed", () => {
    expect(applyStatus(
      { fields: { email: { posture: "deny" } } },
      { fields: { email: { posture: "allow" } } },
    )).toBe("drifted");
  });
});

describe("GET /api/admin/collections", () => {
  it("401s anonymously and 403s for a manager", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    expect((await GET(req() as any)).status).toBe(401);
    expect((await GET(req(marcusCookie) as any)).status).toBe(403);
  });

  it("returns every collection with its full posture list, including denied fields", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    const people = body.collections.find((c: any) => c.name === "people");
    const home = people.fields.find((f: any) => f.name === "home_address");
    // Admins configure postures, so they see the denied fields BY NAME. No values are
    // returned by this route — it reads app.collections, never a data schema.
    // Postures are normalized to {read, write} form in Phase 2.
    expect(home.posture).toEqual({ read: "deny", write: "deny" });
    expect(people.fields.find((f: any) => f.name === "full_name").posture).toEqual({ read: "allow", write: "deny" });
  });

  it("marks a collection applied after applyConfig ran in the fixture", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    for (const c of body.collections) expect(c.status).toBe("applied");
  });

  it("marks a collection drifted once the stored config diverges", async () => {
    await getAppPool().query(
      `update app.collections set config = jsonb_set(config, '{description}', '"stale"') where name='metrics'`);
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    expect(body.collections.find((c: any) => c.name === "metrics").status).toBe("drifted");
  });

  it("marks a collection not_applied when there is no row", async () => {
    await getAppPool().query(`delete from app.collections where name='announcements'`);
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    expect(body.collections.find((c: any) => c.name === "announcements").status).toBe("not_applied");
  });
});
