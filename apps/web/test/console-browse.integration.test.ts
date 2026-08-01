import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";
import { DENIED_CANARY } from "../../../packages/broker/test/fixtures/canaries";

// The console's own read path, held to the same rules as every other adapter.
//
// The point of routing the data browser through broker.query rather than giving the console a
// privileged reader is that these three properties come for free — deny-by-default, denied means
// absent, one audit row per decision. "For free" is a claim, so it is tested here rather than
// assumed from the fact that the code calls the broker.

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, miaCookie: string;

const params = (c: string) => ({ params: Promise.resolve({ c }) });

beforeAll(async () => {
  db = await setupWebDbWithData("consolebrowse");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");

  // A value that must never come back, planted in a posture:deny column of a row the caller is
  // otherwise allowed to read. Grepping the whole response body is the only check that catches
  // it leaking through a field list, an error message or a stray debug key alike.
  await getAppPool().query(
    `update data_synth.people set home_address = $1
      where id = (select id from data_synth.people order by id limit 1)`,
    [DENIED_CANARY],
  );
}, 60_000);

afterAll(async () => {
  await db?.end();
});

function queryReq(collection: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost:8722/api/collections/${collection}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function approvedGrant(userId: string, collection: string, fields: string[], env = "dev") {
  await getAppPool().query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label,decided_by,decided_at)
     values ($1,$2,$3,'approved',$4,'console browsing','marcus',now())
     on conflict do nothing`,
    [userId, collection, env, fields],
  );
}

async function auditCount(): Promise<number> {
  const r = await getAppPool().query<{ n: string }>(
    `select count(*)::text as n from app.audit_events`,
  );
  return Number(r.rows[0]!.n);
}

describe("POST /api/collections/[c]/query", () => {
  it("401s without a session — the route is grant-gated, not open", async () => {
    const { POST } = await import("../app/api/collections/[c]/query/route");
    const res = await POST(queryReq("people", {}) as any, params("people"));
    expect(res.status).toBe(401);
  });

  it("refuses no_grant, and says so in the body the console branches on", async () => {
    const { POST } = await import("../app/api/collections/[c]/query/route");
    const res = await POST(queryReq("salaries", {}, miaCookie) as any, params("salaries"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, reason: "no_grant" });
  });

  // Being an admin is not a grant. Nothing about this route treats ana differently from mia.
  it("refuses an admin with no grant exactly as it refuses a member", async () => {
    const { POST } = await import("../app/api/collections/[c]/query/route");
    const res = await POST(queryReq("salaries", {}, anaCookie) as any, params("salaries"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, reason: "no_grant" });
  });

  it("returns only the granted fields", async () => {
    await approvedGrant("ana", "people", ["id", "full_name", "email"]);
    const { POST } = await import("../app/api/collections/[c]/query/route");
    const res = await POST(queryReq("people", { limit: 5 }, anaCookie) as any, params("people"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(new Set(body.fieldsReturned)).toEqual(new Set(["id", "full_name", "email"]));
    expect(body.documents.length).toBeGreaterThan(0);
    for (const d of body.documents)
      expect(Object.keys(d).sort()).toEqual(["email", "full_name", "id"]);
  });

  // Invariant 4, whole-body: not "home_address is absent from documents" but "the canary appears
  // nowhere in the bytes we sent".
  it("never lets a denied field's value reach the response, anywhere in it", async () => {
    await approvedGrant("ana", "people", ["id", "full_name", "email"]);
    const { POST } = await import("../app/api/collections/[c]/query/route");

    const all = await POST(queryReq("people", { limit: 200 }, anaCookie) as any, params("people"));
    expect(await all.text()).not.toContain(DENIED_CANARY);

    // Asking for it by name is a refusal, and the refusal carries nothing back either.
    const named = await POST(
      queryReq("people", { fields: ["id", "home_address"] }, anaCookie) as any,
      params("people"),
    );
    expect(named.status).toBe(403);
    const namedBody = await named.text();
    expect(namedBody).toContain("field_denied");
    expect(namedBody).not.toContain(DENIED_CANARY);

    // And so is filtering on it, which would otherwise be an oracle: match/no-match tells you
    // the value without ever returning it.
    const filtered = await POST(
      queryReq(
        "people",
        { fields: ["id"], filters: [{ field: "home_address", op: "eq", value: DENIED_CANARY }] },
        anaCookie,
      ) as any,
      params("people"),
    );
    expect(filtered.status).toBe(403);
    expect(await filtered.text()).not.toContain(DENIED_CANARY);
  });

  it("writes exactly one audit row per call — allow and refusal alike", async () => {
    await approvedGrant("ana", "announcements", ["id", "title"]);
    const { POST } = await import("../app/api/collections/[c]/query/route");

    const before = await auditCount();
    await POST(queryReq("announcements", { limit: 1 }, anaCookie) as any, params("announcements"));
    expect(await auditCount()).toBe(before + 1);

    const beforeRefusal = await auditCount();
    await POST(queryReq("salaries", {}, miaCookie) as any, params("salaries"));
    expect(await auditCount()).toBe(beforeRefusal + 1);
  });

  it("names the fields it returned in the audit row", async () => {
    await approvedGrant("ana", "metrics", ["id", "date", "revenue"]);
    const { POST } = await import("../app/api/collections/[c]/query/route");
    const res = await POST(
      queryReq("metrics", { fields: ["id", "revenue"], limit: 1 }, anaCookie) as any,
      params("metrics"),
    );
    const { auditId } = await res.json();
    const row = (
      await getAppPool().query(
        `select fields_returned, outcome from app.audit_events where id=$1`,
        [auditId],
      )
    ).rows[0];
    expect(row.outcome).toBe("allowed");
    expect(new Set(row.fields_returned)).toEqual(new Set(["id", "revenue"]));
  });

  it("refuses a malformed body rather than defaulting to everything", async () => {
    const { POST } = await import("../app/api/collections/[c]/query/route");
    const res = await POST(
      new Request("http://localhost:8722/api/collections/people/query", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: anaCookie },
        body: "not json",
      }) as any,
      params("people"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, reason: "invalid_intent" });
  });

  // Two sources for one value is a question about which wins; the path is the answer.
  it("ignores a collection named in the body", async () => {
    await approvedGrant("ana", "people", ["id", "full_name", "email"]);
    const { POST } = await import("../app/api/collections/[c]/query/route");
    const res = await POST(
      queryReq("people", { collection: "salaries", limit: 1 }, anaCookie) as any,
      params("people"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).fieldsReturned).toContain("full_name");
  });
});

describe("GET /api/collections/[c]/search", () => {
  function searchReq(collection: string, qs: string, cookie?: string) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    return new Request(`http://localhost:8722/api/collections/${collection}/search?${qs}`, {
      headers,
    });
  }

  it("401s without a session", async () => {
    const { GET } = await import("../app/api/collections/[c]/search/route");
    const res = await GET(searchReq("policies", "q=leave") as any, params("policies"));
    expect(res.status).toBe(401);
  });

  it("refuses no_grant with the reason in the body", async () => {
    const { GET } = await import("../app/api/collections/[c]/search/route");
    const res = await GET(searchReq("precedents", "q=x", miaCookie) as any, params("precedents"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, reason: "no_grant" });
  });

  it("returns ranked segments from a file collection, granted fields only", async () => {
    await approvedGrant("ana", "policies", ["title", "content", "owner", "updated_at"]);
    const { GET } = await import("../app/api/collections/[c]/search/route");
    const res = await GET(searchReq("policies", "q=remote", anaCookie) as any, params("policies"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.documents.length).toBeGreaterThan(0);
    // `path` is posture: deny in harbor, so it is not in the grant and not in the answer.
    for (const d of body.documents) expect("path" in d).toBe(false);
  });

  it("refuses a non-numeric limit as an invalid intent rather than passing NaN down", async () => {
    await approvedGrant("ana", "policies", ["title", "content", "owner", "updated_at"]);
    const { GET } = await import("../app/api/collections/[c]/search/route");
    const res = await GET(
      searchReq("policies", "q=remote&limit=abc", anaCookie) as any,
      params("policies"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, reason: "invalid_intent" });
  });
});
