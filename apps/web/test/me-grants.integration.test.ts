import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let miaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("megrants");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  const app = getAppPool();
  await app.query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label)
     values ('mia','announcements','dev','approved',array['id','title'],'newsletter')`);
  await app.query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,expires_at)
     values ('mia','metrics','dev','approved',array['id','date'], now() - interval '1 day')`);
  await app.query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label)
     values ('marcus','salaries','dev','pending',array['id'],'comp review')`);
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(url: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request(`http://localhost:8722${url}`, { headers });
}

describe("GET /api/me/grants", () => {
  it("401s without a session", async () => {
    const { GET } = await import("../app/api/me/grants/route");
    const res = await GET(req("/api/me/grants") as any);
    expect(res.status).toBe(401);
  });

  it("returns only the caller's own grants", async () => {
    const { GET } = await import("../app/api/me/grants/route");
    const body = await (await GET(req("/api/me/grants", miaCookie) as any)).json();
    expect(body.grants.length).toBeGreaterThan(0);
    for (const g of body.grants) expect(g.user_id).toBe("mia");
    expect(body.grants.some((g: any) => g.collection === "salaries")).toBe(false);
  });

  it("ignores a planted ?user= param", async () => {
    const { GET } = await import("../app/api/me/grants/route");
    const body = await (await GET(req("/api/me/grants?user=marcus", miaCookie) as any)).json();
    for (const g of body.grants) expect(g.user_id).toBe("mia");
  });

  it("reports an approved-but-past-expiry grant as expired", async () => {
    const { GET } = await import("../app/api/me/grants/route");
    const body = await (await GET(req("/api/me/grants", miaCookie) as any)).json();
    const metrics = body.grants.find((g: any) => g.collection === "metrics");
    expect(metrics.status).toBe("approved");
    expect(metrics.effectiveStatus).toBe("expired");
  });

  it("annotates file collections with their type and taxonomy field", async () => {
    const app = getAppPool();
    await app.query(
      `insert into app.grants (user_id,collection,env,status,allowed_fields)
       values ('mia','policies','live','pending',array['title'])`);
    const { GET } = await import("../app/api/me/grants/route");
    const body = await (await GET(req("/api/me/grants", miaCookie) as any)).json();
    const policies = body.grants.find((g: any) => g.collection === "policies");
    expect(policies.collectionType).toBe("file");
    expect(policies.taxonomyField).toBe("category");
  });
});

describe("GET /api/grants pending queue", () => {
  it("does not disclose other users' pending requests to a member", async () => {
    const { GET } = await import("../app/api/grants/route");
    const body = await (await GET(req("/api/grants", miaCookie) as any)).json();
    expect(body.pending).toEqual([]);
  });

  it("still returns the pending queue to a manager", async () => {
    const { GET } = await import("../app/api/grants/route");
    const body = await (await GET(req("/api/grants", marcusCookie) as any)).json();
    expect(body.pending.some((g: any) => g.collection === "salaries")).toBe(true);
  });
});
