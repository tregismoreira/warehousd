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
afterAll(async () => {
  await db?.end();
});

function req(cookie?: string, qs = "") {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request(`http://localhost:8722/api/admin/collections${qs}`, { headers });
}

/** The list surface's call: counting is opt-in because it is a scan per collection. */
const counted = (cookie: string) => req(cookie, "?counts=1");

function detailReq(name: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request(`http://localhost:8722/api/admin/collections/${name}`, { headers });
}

const params = (name: string) => ({ params: Promise.resolve({ name }) });

async function detail(name: string, cookie?: string) {
  const { GET } = await import("../app/api/admin/collections/[name]/route");
  return GET(detailReq(name, cookie) as any, params(name));
}

describe("applyStatus", () => {
  it("reports not_applied when nothing is recorded", () => {
    expect(applyStatus({ a: 1 }, null)).toBe("not_applied");
  });
  it("reports applied when the two configs match regardless of key order", () => {
    expect(applyStatus({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe("applied");
  });
  it("reports drifted when a posture changed", () => {
    expect(
      applyStatus(
        { fields: { email: { posture: "deny" } } },
        { fields: { email: { posture: "allow" } } },
      ),
    ).toBe("drifted");
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
    expect(home.posture).toEqual({ read: "deny", write: "deny", unmask: "deny" });
    expect(people.fields.find((f: any) => f.name === "full_name").posture).toEqual({
      read: "allow",
      write: "deny",
      unmask: "deny",
    });
  });

  // The console's environment is the cookie's, and the counts follow it. Without this the
  // env switcher was decoration on every admin page: it was rendered by the shell but no
  // admin surface read it.
  it("counts documents for the cookie's environment", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    const dev = await (await GET(counted(anaCookie) as any)).json();
    const live = await (await GET(counted(`${anaCookie}; wh_env=live`) as any)).json();

    expect(dev.env).toBe("dev");
    expect(live.env).toBe("live");

    const count = (body: any, name: string) =>
      body.collections.find((c: any) => c.name === name).documentCount;
    expect(count(dev, "people")).toBeGreaterThan(0);
    // harbor's live seed is deliberately smaller than its synthetic dev data.
    expect(count(live, "people")).not.toBe(count(dev, "people"));
  });

  // Three of this endpoint's four callers never render a count, and `count(*)` over a view is a
  // scan. Opening the overview or the audit browser must not pay for twenty of them.
  it("does not count unless asked", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    for (const c of body.collections) expect("documentCount" in c).toBe(false);
  });

  it("reports searchable alongside the postures, so the field table can show it", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    const people = body.collections.find((c: any) => c.name === "people");
    for (const f of people.fields) expect(typeof f.searchable).toBe("boolean");
  });

  it("marks a collection applied after applyConfig ran in the fixture", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    for (const c of body.collections) expect(c.status).toBe("applied");
  });

  it("marks a collection drifted once the stored config diverges", async () => {
    await getAppPool().query(
      `update app.collections set config = jsonb_set(config, '{description}', '"stale"') where name='metrics'`,
    );
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    expect(body.collections.find((c: any) => c.name === "metrics").status).toBe("drifted");
  });

  it("marks a collection not_applied when there is no row", async () => {
    await getAppPool().query(`delete from app.collections where name='announcements'`);
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    expect(body.collections.find((c: any) => c.name === "announcements").status).toBe(
      "not_applied",
    );
  });

  // Never applied and applied-but-empty are different facts, and an admin looking at a fresh
  // environment has to be able to tell them apart. `announcements` was un-applied above.
  it("reports a null count for a collection nothing has been applied for", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(counted(anaCookie) as any)).json();
    expect(body.collections.find((c: any) => c.name === "announcements").documentCount).toBeNull();
    expect(body.collections.find((c: any) => c.name === "people").documentCount).toBeGreaterThan(0);
  });
});

describe("GET /api/admin/collections/[name]", () => {
  it("401s anonymously and 403s for a manager", async () => {
    expect((await detail("people")).status).toBe(401);
    expect((await detail("people", marcusCookie)).status).toBe(403);
  });

  it("404s on a collection the config does not declare", async () => {
    const res = await detail("nope", anaCookie);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_collection");
  });

  it("returns the fields with both posture axes and the environment's count", async () => {
    const body = await (await detail("people", anaCookie)).json();
    expect(body.type).toBe("dataset");
    expect(body.env).toBe("dev");
    expect(body.status).toBe("applied");
    expect(body.documentCount).toBeGreaterThan(0);

    const home = body.fields.find((f: any) => f.name === "home_address");
    expect(home.posture).toEqual({ read: "deny", write: "deny", unmask: "deny" });
    const joined = body.fields.find((f: any) => f.name === "department_name");
    expect(joined.view_join).toEqual({ table: "departments", column: "name", on: "department_id" });
  });

  it("serves the broker's own filter operators rather than a restatement of them", async () => {
    const body = await (await detail("people", anaCookie)).json();
    expect(body.filterOps).toEqual(["eq", "neq", "gt", "lt", "gte", "lte", "like", "in"]);
  });

  it("returns the bound vocabularies with resolved labels and per-term counts", async () => {
    const body = await (await detail("policies", anaCookie)).json();
    expect(body.type).toBe("file");
    expect(body.taxonomies.map((t: any) => t.field).sort()).toEqual(["department", "tags"]);

    const department = body.taxonomies.find((t: any) => t.field === "department");
    expect(department.multiple).toBe(false);
    expect(department.source).toBeNull();
    expect(department.applied).toBe(true);
    const hr = department.terms.find((t: any) => t.slug === "hr");
    expect(hr.label).toBe("HR");
    expect(hr.documentCount).toBeGreaterThan(0);

    expect(body.taxonomies.find((t: any) => t.field === "tags").multiple).toBe(true);
  });

  it("returns an empty taxonomy list for a collection that binds none", async () => {
    const body = await (await detail("metrics", anaCookie)).json();
    expect(body.taxonomies).toEqual([]);
  });

  it("follows the env cookie for counts and terms", async () => {
    const dev = await (await detail("policies", anaCookie)).json();
    const live = await (await detail("policies", `${anaCookie}; wh_env=live`)).json();
    expect(live.env).toBe("live");
    expect(live.documentCount).not.toBe(dev.documentCount);
  });

  // The caller's own grant, and only ever their own — the data browser needs it to tell
  // "grantable but not granted" from "denied by posture".
  it("carries the caller's own grant, and null when they hold none", async () => {
    expect((await (await detail("people", anaCookie)).json()).grant).toBeNull();

    await getAppPool().query(
      `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label,decided_by,decided_at)
       values ('ana','people','dev','approved',array['id','full_name'],'t','marcus',now())`,
    );
    const body = await (await detail("people", anaCookie)).json();
    expect(body.grant.allowedFields).toEqual(["id", "full_name"]);
    expect(body.grant.verbs).toEqual(["read"]);

    // Marcus's grant is not ana's, and a grant in the other environment is not this one's.
    await getAppPool().query(
      `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label,decided_by,decided_at)
       values ('ana','people','live','approved',array['id'],'t','marcus',now())`,
    );
    expect((await (await detail("people", anaCookie)).json()).grant.allowedFields).toEqual([
      "id",
      "full_name",
    ]);
    expect(
      (await (await detail("people", `${anaCookie}; wh_env=live`)).json()).grant.allowedFields,
    ).toEqual(["id"]);
  });

  it("still describes a collection that has never been applied, with nulls for its data", async () => {
    const body = await (await detail("announcements", anaCookie)).json();
    expect(body.status).toBe("not_applied");
    expect(body.documentCount).toBeNull();
    expect(body.fields.length).toBeGreaterThan(0);
    // Declared and bound in the YAML; only its terms are missing, because nothing applied them.
    expect(body.taxonomies.map((t: any) => t.field)).toEqual(["department"]);
    expect(body.taxonomies[0].applied).toBe(false);
    expect(body.taxonomies[0].terms).toEqual([]);
  });
});

describe("GET /api/admin/collections/[name]/files", () => {
  async function files(name: string, cookie?: string) {
    const { GET } = await import("../app/api/admin/collections/[name]/files/route");
    const headers: Record<string, string> = {};
    if (cookie) headers["cookie"] = cookie;
    return GET(
      new Request(`http://localhost:8722/api/admin/collections/${name}/files`, {
        headers,
      }) as any,
      params(name),
    );
  }

  it("401s anonymously and 403s for a manager", async () => {
    expect((await files("policies")).status).toBe(401);
    expect((await files("policies", marcusCookie)).status).toBe(403);
  });

  it("400s on a dataset collection rather than guessing a table name", async () => {
    const res = await files("people", anaCookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_a_file_collection");
  });

  it("lists the indexed files with their document counts", async () => {
    const body = await (await files("policies", anaCookie)).json();
    expect(body.files.length).toBeGreaterThan(0);
    for (const f of body.files) {
      expect(f.documentCount).toBeGreaterThan(0);
      expect(typeof f.checksum).toBe("string");
      expect(typeof f.title).toBe("string");
    }
  });

  // Invariant 4 reaches the console too: `path` is posture: deny in harbor, so being an admin
  // does not produce it. Absent from the row, not null in it.
  it("omits a denied field entirely, and says which fields it did return", async () => {
    const res = await files("policies", anaCookie);
    const raw = await res.clone().text();
    const body = await res.json();

    expect(body.fields.sort()).toEqual(["owner", "title", "updated_at"]);
    for (const f of body.files) expect("path" in f).toBe(false);
    expect(raw).not.toContain("remote-work.md");
  });

  // A grant that names the field is the one thing that changes the answer — the same rule the
  // approver's path picker follows.
  it("returns path once the caller's own grant names it", async () => {
    await getAppPool().query(
      `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label,decided_by,decided_at)
       values ('ana','policies','dev','approved',array['title','path'],'t','marcus',now())`,
    );
    const body = await (await files("policies", anaCookie)).json();
    expect(body.fields).toContain("path");
    expect(body.files.map((f: any) => f.path)).toContain("remote-work.md");
  });
});
