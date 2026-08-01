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
afterAll(async () => {
  await db?.end();
});

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
    [user, collection, env, fields],
  );
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
    const res = await POST(
      req(
        {
          action: "approve",
          id,
          allowedFields: ["title", "content"],
          selectedPaths: ["security.md"],
        },
        marcusCookie,
      ) as any,
    );
    expect(res.status).toBe(200);
    const g = await grantRow(id);
    expect(g.status).toBe("approved");
    expect(g.document_filter).toEqual([{ field: "path", op: "in", value: ["security.md"] }]);
  });

  it("term selection lands in documentFilters array on the taxonomy field", async () => {
    // Not marcus: he is the approver below, and a live grant may not be self-approved.
    const id = await pending("terms_target", "policies", ["title", "content"], "live");
    const { POST } = await import("../app/api/grants/route");
    await POST(
      req(
        {
          action: "approve",
          id,
          allowedFields: ["title", "content"],
          selectedTerms: { department: ["hr", "finance"] },
        },
        marcusCookie,
      ) as any,
    );
    const g = await grantRow(id);
    expect(g.document_filter).toEqual([
      { field: "department", op: "in", value: ["hr", "finance"] },
    ]);
  });

  it("terms and paths can coexist in the documentFilters array", async () => {
    const id = await pending("mia", "policies", ["title"], "dev");
    const { POST } = await import("../app/api/grants/route");
    await POST(
      req(
        {
          action: "approve",
          id,
          allowedFields: ["title"],
          selectedPaths: ["hr/pto.md"],
          selectedTerms: { department: ["finance"] },
        },
        marcusCookie,
      ) as any,
    );
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
    await POST(
      req(
        {
          action: "approve",
          id,
          allowedFields: ["content"],
          selectedTerms: { department: ["hr"] },
          documentFilter: [{ field: "content", op: "in", value: ["anything"] }], // forged
        },
        marcusCookie,
      ) as any,
    );
    const g = await grantRow(id);
    expect(g.document_filter[0].field).toBe("department");
  });
});

describe("approve — field trimming", () => {
  it("trims to a subset of what was requested", async () => {
    const id = await pending("mia", "people", ["id", "full_name", "email"]);
    const { POST } = await import("../app/api/grants/route");
    await POST(
      req({ action: "approve", id, allowedFields: ["id", "full_name"] }, marcusCookie) as any,
    );
    expect((await grantRow(id)).allowed_fields).toEqual(["id", "full_name"]);
  });

  it("refuses to widen beyond what was requested", async () => {
    const id = await pending("marcus", "people", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(
      req(
        {
          action: "approve",
          id,
          allowedFields: ["id", "email"],
        },
        marcusCookie,
      ) as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot_widen");
    expect((await grantRow(id)).status).toBe("pending");
  });

  it("refuses a posture:deny field even if it somehow reached the request", async () => {
    const id = await pending("marcus", "people", ["id", "home_address"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(
      req(
        {
          action: "approve",
          id,
          allowedFields: ["id", "home_address"],
        },
        marcusCookie,
      ) as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("field_not_grantable");
  });
});

describe("approve — expiry", () => {
  it("persists a future expiry", async () => {
    const id = await pending("marcus", "metrics", ["id", "date"]);
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const { POST } = await import("../app/api/grants/route");
    await POST(
      req(
        { action: "approve", id, allowedFields: ["id", "date"], expiresAt: when },
        marcusCookie,
      ) as any,
    );
    expect(new Date((await grantRow(id)).expires_at).toISOString()).toBe(when);
  });

  it("refuses an expiry in the past", async () => {
    const id = await pending("mia", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(
      req(
        {
          action: "approve",
          id,
          allowedFields: ["id"],
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
        marcusCookie,
      ) as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("expiry_in_past");
  });

  it("refuses an unparseable expiry", async () => {
    const id = await pending("marcus", "metrics", ["date"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(
      req(
        {
          action: "approve",
          id,
          allowedFields: ["date"],
          expiresAt: "next tuesday",
        },
        marcusCookie,
      ) as any,
    );
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

// The route's half of the live self-approval rule: the reason code has to survive as a 403 with
// its own name, because the console's one-click "request & approve" branches on exactly that
// string to tell the user their request is waiting for somebody else.
describe("approve — self-approval", () => {
  it("403s with self_approval_denied on live, and leaves the grant pending", async () => {
    const id = await pending("marcus", "metrics", ["id"], "live");
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(
      req({ action: "approve", id, allowedFields: ["id"] }, marcusCookie) as any,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("self_approval_denied");
    expect((await grantRow(id)).status).toBe("pending");
  });

  it("allows the same person to approve their own dev grant", async () => {
    const id = await pending("marcus", "vendors", ["id", "name"], "dev");
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(
      req({ action: "approve", id, allowedFields: ["id", "name"] }, marcusCookie) as any,
    );
    expect(res.status).toBe(200);
    expect((await grantRow(id)).status).toBe("approved");
  });
});

// Nothing above this line exercised the two actions that take access away, which is the half of
// the lifecycle that matters when something has gone wrong. Both are state machines enforced in
// SQL — deny moves pending → denied, revoke moves approved → revoked — so a call from the wrong
// starting state has to change nothing, and each asserts the row afterwards rather than the
// status code, because a route that updated nothing would return 200 just as happily.
const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";

// `grants_one_active` is unique on (org_id, user_id, collection, env) where status='approved', and
// the seeded template already holds approved grants for the personas. So the owner here is a
// synthetic id per test rather than mia or marcus: the session doing the deciding is what these
// tests are about, and the grant's owner only has to be somebody.
async function approved(owner: string, collection: string, fields: string[]) {
  const r = await getAppPool().query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label,decided_by,decided_at)
     values ($1,$2,'dev','approved',$3,'test','marcus',now()) returning id`,
    [owner, collection, fields],
  );
  return r.rows[0].id as string;
}

describe("deny", () => {
  it("moves a pending grant to denied", async () => {
    const id = await pending("mia", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "deny", id }, marcusCookie) as any);
    expect(res.status).toBe(200);
    expect((await grantRow(id)).status).toBe("denied");
  });

  it("404s on an id that does not exist", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "deny", id: UNKNOWN_ID }, marcusCookie) as any);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_grant");
  });

  // Deny is pending-only. An already-approved grant is not denied "back" — that is what revoke is
  // for — and the grant must be left approved rather than quietly transitioned.
  it("refuses an already-approved grant and leaves it approved", async () => {
    const id = await approved("deny_target_approved", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "deny", id }, marcusCookie) as any);
    expect(res.status).toBe(404);
    expect((await grantRow(id)).status).toBe("approved");
  });

  it("a member cannot deny", async () => {
    const id = await pending("marcus", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "deny", id }, miaCookie) as any);
    expect(res.status).toBe(403);
    expect((await grantRow(id)).status).toBe("pending");
  });
});

describe("revoke", () => {
  it("moves an approved grant to revoked", async () => {
    const id = await approved("revoke_target", "announcements", ["id", "title"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "revoke", id }, marcusCookie) as any);
    expect(res.status).toBe(200);
    expect((await grantRow(id)).status).toBe("revoked");
  });

  it("404s on an id that does not exist", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "revoke", id: UNKNOWN_ID }, marcusCookie) as any);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_grant");
  });

  // The mirror of the deny case: revoke is approved-only, so a pending grant stays pending rather
  // than skipping a decision nobody made.
  it("refuses a still-pending grant and leaves it pending", async () => {
    const id = await pending("mia", "announcements", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "revoke", id }, marcusCookie) as any);
    expect(res.status).toBe(404);
    expect((await grantRow(id)).status).toBe("pending");
  });

  it("a member cannot revoke", async () => {
    const id = await approved("revoke_target_member", "announcements", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "revoke", id }, miaCookie) as any);
    expect(res.status).toBe(403);
    expect((await grantRow(id)).status).toBe("approved");
  });
});

describe("approve — the grant has to exist and be pending", () => {
  it("404s on an id that does not exist", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(
      req({ action: "approve", id: UNKNOWN_ID, allowedFields: [] }, marcusCookie) as any,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_grant");
  });

  // 409, not 404: the grant is there and the caller may see it, so "already decided" is the honest
  // answer and the one a UI can act on by refreshing.
  it("409s on a grant that was already decided", async () => {
    const id = await approved("approve_target_decided", "metrics", ["id", "date"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(
      req({ action: "approve", id, allowedFields: ["id"] }, marcusCookie) as any,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_pending");
  });

  // The refusal that comes back from approveGrant rather than from the route's own guards, which
  // is a different status mapping: anything that is not unknown_grant is the caller's 400.
  it("400s when the verbs are not a set this collection can carry", async () => {
    const id = await pending("mia", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(
      req({ action: "approve", id, allowedFields: ["id"], verbs: ["fly"] }, marcusCookie) as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_verbs");
    expect((await grantRow(id)).status).toBe("pending");
  });
});

describe("an action the route does not know", () => {
  it("400s rather than falling through to a silent success", async () => {
    const id = await pending("mia", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "obliterate", id }, marcusCookie) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_action");
    expect((await grantRow(id)).status).toBe("pending");
  });
});
