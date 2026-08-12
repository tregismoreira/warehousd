import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { setMember } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let anaCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("wsswitch");
  const app = getAppPool();
  await app.query(
    `insert into app.workspaces (id, name) values ('w2', 'W2') on conflict do nothing`,
  );
  // Ana: member of 'default' (bootstrap admin) and 'w2'. Mia stays 'default'-only, so naming
  // w2 for her is a non-membership.
  await setMember(app, { workspaceId: "w2", userId: "ana", role: "member" });
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("POST /api/me/workspace", () => {
  it("switches to a workspace the caller is a member of, and the next deriveContext reflects it", async () => {
    const { POST } = await import("../app/api/me/workspace/route");
    const res = await POST(
      req("/api/me/workspace", {
        method: "POST",
        cookie: anaCookie,
        body: { workspaceId: "w2" },
      }) as any,
    );
    expect(res.status).toBe(200);

    const { deriveContext } = await import("../lib/session");
    const ctx = await deriveContext(
      new Request("http://localhost:8722/", { headers: { cookie: anaCookie } }),
    );
    expect(ctx?.workspaceId).toBe("w2");

    // Restore, so later tests in this file see the bootstrap default.
    const back = await POST(
      req("/api/me/workspace", {
        method: "POST",
        cookie: anaCookie,
        body: { workspaceId: "default" },
      }) as any,
    );
    expect(back.status).toBe(200);
  });

  it("naming a non-membership refuses with 403 and changes nothing", async () => {
    const app = getAppPool();
    const before = await app.query(
      `select "activeWorkspaceId" from app.session where "userId"='mia'`,
    );

    const { POST } = await import("../app/api/me/workspace/route");
    const res = await POST(
      req("/api/me/workspace", {
        method: "POST",
        cookie: miaCookie,
        body: { workspaceId: "w2" },
      }) as any,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });

    const after = await app.query(
      `select "activeWorkspaceId" from app.session where "userId"='mia'`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe("GET /api/me/workspace", () => {
  it("returns exactly the caller's memberships — a second user's workspace is absent", async () => {
    const { GET } = await import("../app/api/me/workspace/route");
    const res = await GET(req("/api/me/workspace", { cookie: anaCookie }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.memberships.map((m: any) => m.workspaceId).sort();
    expect(ids).toEqual(["default", "w2"]);

    const miaRes = await GET(req("/api/me/workspace", { cookie: miaCookie }) as any);
    const miaBody = await miaRes.json();
    expect(miaBody.memberships.map((m: any) => m.workspaceId)).toEqual(["default"]);
  });
});
