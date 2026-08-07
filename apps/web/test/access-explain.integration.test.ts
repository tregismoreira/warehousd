import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

// §P5 through the console route. The broker's own rules are pinned in
// packages/broker/test/explain-access.test.ts; what is asserted here is that the route does not
// widen them — the caller's role comes from the database, never from the request.

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("accessexplain");
  // ana is admin, marcus is manager, mia is a member — the harbor personas.
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

function ask(cookie: string, collection: string, subject?: string) {
  const q = new URLSearchParams({ collection });
  if (subject) q.set("subject", subject);
  return new Request(`http://localhost:8722/api/access?${q.toString()}`, { headers: { cookie } });
}

async function subjectId(email: string): Promise<string> {
  const r = await getAppPool().query<{ id: string }>(`select id from app."user" where email=$1`, [
    email,
  ]);
  return r.rows[0]!.id;
}

describe("GET /api/access", () => {
  it("401s without a session", async () => {
    const { GET } = await import("../app/api/access/route");
    const res = await GET(ask("", "people") as never);
    expect(res.status).toBe(401);
  });

  it("400s without a collection", async () => {
    const { GET } = await import("../app/api/access/route");
    const req = new Request("http://localhost:8722/api/access", {
      headers: { cookie: anaCookie },
    });
    const res = await GET(req as never);
    expect(res.status).toBe(400);
  });

  it("403s a member asking about somebody else", async () => {
    const { GET } = await import("../app/api/access/route");
    const res = await GET(ask(miaCookie, "people", await subjectId("ana@harbor.demo")) as never);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_authorized");
  });

  it("lets a member ask about themselves", async () => {
    const { GET } = await import("../app/api/access/route");
    const res = await GET(ask(miaCookie, "people") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collection).toBe("people");
    expect(Array.isArray(body.fields)).toBe(true);
  });

  it("lets a manager ask about anybody", async () => {
    const { GET } = await import("../app/api/access/route");
    const res = await GET(ask(marcusCookie, "people", await subjectId("mia@harbor.demo")) as never);
    expect(res.status).toBe(200);
  });

  it("names a denied field to the console, and no value of it", async () => {
    const { GET } = await import("../app/api/access/route");
    const res = await GET(ask(anaCookie, "people", await subjectId("mia@harbor.demo")) as never);
    const body = await res.json();

    // Naming a `deny` field is safe HERE and nowhere else: the caller is a person who can read
    // warehousd.yml, and telling them "the config denies it" is what stops them filing a ticket
    // asking for a grant that can never exist. A grant-carrying caller never learns this.
    const denied = body.fields.filter((f: { posture: string }) => f.posture === "deny");
    expect(denied.length).toBeGreaterThan(0);
    for (const f of denied) expect(f.blockedBy).toBe("posture");

    // What it must never carry: a stored value. Every field entry is booleans and enums.
    for (const f of body.fields)
      expect(Object.keys(f).sort()).toEqual(
        [
          "blockedBy",
          "effect",
          "field",
          "grantable",
          "granted",
          "posture",
          "unmaskable",
          "unmasked",
          "writable",
        ].sort(),
      );
  });

  it("404s an unknown collection", async () => {
    const { GET } = await import("../app/api/access/route");
    const res = await GET(ask(anaCookie, "no_such_collection") as never);
    expect(res.status).toBe(404);
  });
});
