import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("grantreq");
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

describe("POST /api/grants action=request", () => {
  it("creates a pending grant owned by the session user", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "departments",
              purposeLabel: "org chart", fields: ["id", "name"] },
    }) as any);
    expect(res.status).toBe(200);
    const { requestId } = await res.json();
    const row = await getAppPool().query(`select * from app.grants where id=$1`, [requestId]);
    expect(row.rows[0]).toMatchObject({
      status: "pending", user_id: "mia", collection: "departments",
      env: "dev", allowed_fields: ["id", "name"], purpose_label: "org chart",
    });
  });

  it("ignores a planted userId in the body", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "metrics", purposeLabel: "kpi",
              userId: "ana", user_id: "ana" },
    }) as any);
    const { requestId } = await res.json();
    const row = await getAppPool().query(`select user_id from app.grants where id=$1`, [requestId]);
    expect(row.rows[0].user_id).toBe("mia");
  });

  it("rejects an unknown collection", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "does_not_exist", purposeLabel: "x" },
    }) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_collection");
  });

  it("rejects a field the YAML marks posture:deny — the two-tier deny holds at request time", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "people", purposeLabel: "directory",
              fields: ["id", "home_address"] },
    }) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("field_not_grantable");
  });

  it("requires a purpose label", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "metrics" },
    }) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("purpose_required");
  });

  it("defaults to every grantable field when fields are omitted", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "salaries", purposeLabel: "benchmarking" },
    }) as any);
    const { requestId } = await res.json();
    const row = await getAppPool().query(`select allowed_fields from app.grants where id=$1`, [requestId]);
    expect(row.rows[0].allowed_fields).not.toContain("ssn");
    expect(row.rows[0].allowed_fields.length).toBeGreaterThan(0);
  });
});

describe("GET /api/me/collections", () => {
  it("lists names, descriptions and grantable fields, never denied fields", async () => {
    const { GET } = await import("../app/api/me/collections/route");
    const body = await (await GET(req("/api/me/collections", { cookie: miaCookie }) as any)).json();
    const people = body.collections.find((c: any) => c.name === "people");
    expect(people.grantableFields).toContain("full_name");
    expect(people.grantableFields).not.toContain("home_address");
    expect(people.description).toBeTruthy();
  });
});
