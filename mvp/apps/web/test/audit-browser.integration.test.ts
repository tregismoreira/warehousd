import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("auditbrowser");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
  const app = getAppPool();
  await app.query(`
    insert into app.audit_events (user_id, env, collection, outcome, reason, fields_returned) values
      ('mia','dev','people','allowed',null,array['id','full_name']),
      ('mia','dev','salaries','refused','no_grant','{}'),
      ('marcus','live','people','allowed',null,array['id']),
      ('marcus','dev','metrics','refused','field_denied','{}')`);
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(qs: string, cookie: string) {
  return new Request(`http://localhost:8722/api/audit${qs}`, { headers: { cookie } });
}

describe("GET /api/audit", () => {
  it("401s without a session", async () => {
    const { GET } = await import("../app/api/audit/route");
    const res = await GET(new Request("http://localhost:8722/api/audit") as any);
    expect(res.status).toBe(401);
  });

  it("scopes a member to their own events only", async () => {
    const { GET } = await import("../app/api/audit/route");
    const body = await (await GET(req("", miaCookie) as any)).json();
    expect(body.events.length).toBeGreaterThan(0);
    for (const e of body.events) expect(e.user_id).toBe("mia");
  });

  it("ignores a member's attempt to filter to someone else", async () => {
    const { GET } = await import("../app/api/audit/route");
    const body = await (await GET(req("?user=marcus", miaCookie) as any)).json();
    for (const e of body.events) expect(e.user_id).toBe("mia");
  });

  it("gives an admin the whole deployment", async () => {
    const { GET } = await import("../app/api/audit/route");
    const body = await (await GET(req("", anaCookie) as any)).json();
    const users = new Set(body.events.map((e: any) => e.user_id));
    expect(users.has("mia")).toBe(true);
    expect(users.has("marcus")).toBe(true);
  });

  it("filters by user, collection, outcome and env for an admin", async () => {
    const { GET } = await import("../app/api/audit/route");
    const byUser = await (await GET(req("?user=marcus", anaCookie) as any)).json();
    for (const e of byUser.events) expect(e.user_id).toBe("marcus");

    const byColl = await (await GET(req("?collection=salaries", anaCookie) as any)).json();
    for (const e of byColl.events) expect(e.collection).toBe("salaries");

    const byOutcome = await (await GET(req("?outcome=refused", anaCookie) as any)).json();
    for (const e of byOutcome.events) expect(e.outcome).toBe("refused");

    const byEnv = await (await GET(req("?env=live", anaCookie) as any)).json();
    for (const e of byEnv.events) expect(e.env).toBe("live");
  });

  it("rejects an unknown outcome value rather than silently ignoring it", async () => {
    const { GET } = await import("../app/api/audit/route");
    const res = await GET(req("?outcome=maybe", anaCookie) as any);
    expect(res.status).toBe(400);
  });

  it("paginates and reports a total", async () => {
    const { GET } = await import("../app/api/audit/route");
    const page = await (await GET(req("?limit=2&offset=0", anaCookie) as any)).json();
    expect(page.events.length).toBe(2);
    expect(page.total).toBeGreaterThanOrEqual(4);
  });

  it("caps an absurd limit", async () => {
    const { GET } = await import("../app/api/audit/route");
    const body = await (await GET(req("?limit=100000", anaCookie) as any)).json();
    expect(body.events.length).toBeLessThanOrEqual(200);
  });
});
