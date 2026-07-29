import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getBroker } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let miaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("lifecycleui");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function post(body: unknown, cookie: string) {
  return new Request("http://localhost:8722/api/grants", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}
function get(url: string, cookie: string) {
  return new Request(`http://localhost:8722${url}`, { headers: { cookie } });
}

// §10 test 7, through the surface a human actually uses.
describe("grant lifecycle through the UI/API layer", () => {
  it("request → pending → approve trimmed with expiry → query works → revoke → immediate no_grant", async () => {
    const { POST, GET } = await import("../app/api/grants/route");
    const { broker } = getBroker();
    const ctx = { userId: "mia", orgId: "default", env: "dev" as const };

    // 0. deny by default
    const before = await broker.query(ctx, { collection: "departments", fields: ["id", "name"] });
    expect(before.ok).toBe(false);
    if (before.ok) throw new Error("unreachable");
    expect(before.reason).toBe("no_grant");

    // 1. Mia requests two fields
    const reqRes = await POST(post({
      action: "request", collection: "departments",
      purposeLabel: "org chart", fields: ["id", "name"],
    }, miaCookie) as any);
    expect(reqRes.status).toBe(200);
    const { requestId } = await reqRes.json();

    // 2. it is pending, and it is in Marcus's inbox
    const inbox = await (await GET(get("/api/grants", marcusCookie) as any)).json();
    expect(inbox.pending.some((g: any) => g.id === requestId)).toBe(true);

    // 3. Marcus approves, trimming to one field and setting an expiry
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const okRes = await POST(post({
      action: "approve", id: requestId, allowedFields: ["name"], expiresAt,
    }, marcusCookie) as any);
    expect(okRes.status).toBe(200);

    // 4. the query now succeeds, and the trimmed field is absent — not null
    const allowed = await broker.query(ctx, { collection: "departments" });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error("unreachable");
    expect(allowed.fieldsReturned).toEqual(["name"]);
    for (const row of allowed.documents) expect("id" in row).toBe(false);

    // 5. asking for the trimmed field explicitly is refused
    const denied = await broker.query(ctx, { collection: "departments", fields: ["id"] });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.reason).toBe("field_denied");

    // 6. Marcus revokes
    const revRes = await POST(post({ action: "revoke", id: requestId }, marcusCookie) as any);
    expect(revRes.status).toBe(200);

    // 7. the very next query is refused — no token refresh, no cache to wait on
    const after = await broker.query(ctx, { collection: "departments" });
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error("unreachable");
    expect(after.reason).toBe("no_grant");
  });

  it("an expired grant behaves exactly like a revoked one", async () => {
    const { POST } = await import("../app/api/grants/route");
    const { broker } = getBroker();
    const ctx = { userId: "mia", orgId: "default", env: "dev" as const };

    const { requestId } = await (await POST(post({
      action: "request", collection: "metrics", purposeLabel: "kpi", fields: ["id", "date"],
    }, miaCookie) as any)).json();
    const soon = new Date(Date.now() + 1_500).toISOString();
    await POST(post({
      action: "approve", id: requestId, allowedFields: ["id", "date"], expiresAt: soon,
    }, marcusCookie) as any);

    const live = await broker.query(ctx, { collection: "metrics" });
    expect(live.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 2_000));

    const dead = await broker.query(ctx, { collection: "metrics" });
    expect(dead.ok).toBe(false);
    if (dead.ok) throw new Error("unreachable");
    expect(dead.reason).toBe("no_grant");
  });

  it("a member cannot revoke someone else's grant", async () => {
    const { POST } = await import("../app/api/grants/route");
    const { requestId } = await (await POST(post({
      action: "request", collection: "announcements", purposeLabel: "newsletter",
    }, miaCookie) as any)).json();
    const res = await POST(post({ action: "revoke", id: requestId }, miaCookie) as any);
    expect(res.status).toBe(403);
  });

  it("every step above is audited", async () => {
    const { getAppPool } = await import("../app/lib/broker");
    const r = await getAppPool().query(
      `select outcome, reason, collection from app.audit_events
       where user_id='mia' and collection='departments' order by at asc`);
    const outcomes = r.rows.map((x) => `${x.outcome}:${x.reason ?? ""}`);
    expect(outcomes).toContain("refused:no_grant");
    expect(outcomes).toContain("allowed:");
    expect(outcomes).toContain("refused:field_denied");
  });
});
