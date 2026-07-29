import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let marcusCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("grantapprove");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(body: unknown, cookie: string) {
  return new Request("http://localhost:8722/api/grants", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function pending(user: string, collection: string, fields: string[], env = "dev") {
  const r = await getAppPool().query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label)
     values ($1,$2,$3,'pending',$4,'test') returning id`,
    [user, collection, env, fields]);
  return r.rows[0].id as string;
}

async function grantRow(id: string) {
  const r = await getAppPool().query(`select * from app.grants where id=$1`, [id]);
  return r.rows[0];
}

describe("approve — document scoping actually persists", () => {
  it("path selection lands in documentFilters array, not a dropped key", async () => {
    const id = await pending("mia", "policies", ["title", "content"], "live");
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["title", "content"],
      selectedPaths: ["security.md"],
    }, marcusCookie) as any);
    expect(res.status).toBe(200);
    const g = await grantRow(id);
    expect(g.status).toBe("approved");
    expect(g.document_filter).toEqual([{ field: "path", op: "in", value: ["security.md"] }]);
  });

  it("term selection lands in documentFilters array on the taxonomy field", async () => {
    const id = await pending("marcus", "policies", ["title", "content"], "live");
    const { POST } = await import("../app/api/grants/route");
    await POST(req({
      action: "approve", id, allowedFields: ["title", "content"],
      selectedTerms: { department: ["hr", "finance"] },
    }, marcusCookie) as any);
    const g = await grantRow(id);
    expect(g.document_filter).toEqual([{ field: "department", op: "in", value: ["hr", "finance"] }]);
  });

  it("terms and paths can coexist in the documentFilters array", async () => {
    const id = await pending("mia", "policies", ["title"], "dev");
    const { POST } = await import("../app/api/grants/route");
    await POST(req({
      action: "approve", id, allowedFields: ["title"],
      selectedPaths: ["hr/pto.md"], selectedTerms: { department: ["finance"] },
    }, marcusCookie) as any);
    const g = await grantRow(id);
    expect(g.document_filter).toHaveLength(2);
    expect(g.document_filter).toContainEqual({ field: "department", op: "in", value: ["finance"] });
    expect(g.document_filter).toContainEqual({ field: "path", op: "in", value: ["hr/pto.md"] });
  });

  it("no selection leaves document_filter null (whole collection)", async () => {
    const id = await pending("marcus", "announcements", ["id", "title"]);
    const { POST } = await import("../app/api/grants/route");
    await POST(req({ action: "approve", id, allowedFields: ["id", "title"] }, marcusCookie) as any);
    const g = await grantRow(id);
    expect(g.document_filter).toBeNull();
  });

  it("a client-supplied filter field is ignored — the field comes from the config", async () => {
    const id = await pending("marcus", "policies", ["content"], "dev");
    const { POST } = await import("../app/api/grants/route");
    await POST(req({
      action: "approve", id, allowedFields: ["content"],
      selectedTerms: { department: ["hr"] },
      documentFilter: [{ field: "content", op: "in", value: ["anything"] }], // forged
    }, marcusCookie) as any);
    const g = await grantRow(id);
    expect(g.document_filter[0].field).toBe("department");
  });
});

describe("approve — field trimming", () => {
  it("trims to a subset of what was requested", async () => {
    const id = await pending("mia", "people", ["id", "full_name", "email"]);
    const { POST } = await import("../app/api/grants/route");
    await POST(req({ action: "approve", id, allowedFields: ["id", "full_name"] }, marcusCookie) as any);
    expect((await grantRow(id)).allowed_fields).toEqual(["id", "full_name"]);
  });

  it("refuses to widen beyond what was requested", async () => {
    const id = await pending("marcus", "people", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["id", "email"],
    }, marcusCookie) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot_widen");
    expect((await grantRow(id)).status).toBe("pending");
  });

  it("refuses a posture:deny field even if it somehow reached the request", async () => {
    const id = await pending("marcus", "people", ["id", "home_address"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["id", "home_address"],
    }, marcusCookie) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("field_not_grantable");
  });
});

describe("approve — expiry", () => {
  it("persists a future expiry", async () => {
    const id = await pending("marcus", "metrics", ["id", "date"]);
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const { POST } = await import("../app/api/grants/route");
    await POST(req({ action: "approve", id, allowedFields: ["id", "date"], expiresAt: when }, marcusCookie) as any);
    expect(new Date((await grantRow(id)).expires_at).toISOString()).toBe(when);
  });

  it("refuses an expiry in the past", async () => {
    const id = await pending("mia", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["id"],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }, marcusCookie) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("expiry_in_past");
  });

  it("refuses an unparseable expiry", async () => {
    const id = await pending("marcus", "metrics", ["date"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["date"], expiresAt: "next tuesday",
    }, marcusCookie) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_expiry");
  });
});

describe("approve — role", () => {
  it("a member cannot approve", async () => {
    const id = await pending("marcus", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "approve", id, allowedFields: ["id"] }, miaCookie) as any);
    expect(res.status).toBe(403);
  });
});
