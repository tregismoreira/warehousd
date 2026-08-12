import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { buildSelect } from "../src/sql/build";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";
import { makeCtx } from "./helpers/ctx";
import { captureLogs } from "./helpers/log-capture";

// Per-document ACLs on the READ path.
//
// The count is the test that started the feature: 1,000 documents with one restricted returns 999
// for a caller who is not on that document's ACL, because the predicate is ANDed into the same
// WHERE clause every aggregate already reads. If it were applied anywhere later — after ranking,
// after LIMIT, in the adapter — the shortfall would itself report how many documents the caller
// cannot see.
//
// Every assertion here fails without the change: with no predicate the count is 1,000, the
// restricted document comes back from getDocument, and the canary appears in a search result.

const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

// The string that must appear nowhere a denied caller can see: not in a response body, not in an
// error, not in a captured log line. Invariant 4.
const CANARY = "zzcanary-restricted-page-content-zz";

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  audit: { enabled: true },
  collections: {
    content: {
      description: "Pages",
      writable: true,
      acl: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" }, searchable: true },
        body: { type: "text", posture: { read: "allow", write: "allow" }, searchable: true },
        weight: { type: "int", posture: { read: "allow", write: "allow" } },
      },
    },
    // A neighbour without ACLs, so "the predicate is only emitted where there is a column for it"
    // is asserted rather than assumed.
    plain: {
      description: "No ACLs here",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: "allow" },
      },
    },
  },
});

const FIELDS = ["id", "title", "body", "weight"];

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
let restrictedId: string;

async function grant(userId: string, collection = "content") {
  await admin.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,verbs)
     values ($1,$2,$3,'dev','approved',array['read','update','delete'])`,
    [userId, collection, collection === "content" ? FIELDS : ["id", "title"]],
  );
}

beforeAll(async () => {
  p = await provision("acl-read");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);

  // 1,000 documents. `weight` is 1 on every one so the sum and the average are exactly countable.
  await admin.query(
    `insert into data_synth.content (${R}, id, title, body, weight)
     select ${RV}, gen_random_uuid(), 'Page ' || g, 'ordinary body ' || g, 1
     from generate_series(1, 1000) g`,
  );
  await admin.query(
    `insert into data_synth.plain (${R}, id, title) values (${RV}, gen_random_uuid(), 'plain one')`,
  );

  // One of them is restricted, and it is the only one carrying the canary.
  const one = await admin.query<{ id: string }>(
    `select id from data_synth.content order by title limit 1`,
  );
  restrictedId = one.rows[0]!.id;
  await admin.query(`update data_synth.content set body = $2 where id = $1`, [
    restrictedId,
    `${CANARY} secret`,
  ]);
  await admin.query(
    `insert into data_synth."_acl" (workspace_id, collection, document_id, principals, updated_by)
     values ('default','content',$1, array['user:owner','group:editors'],'test')`,
    [restrictedId],
  );

  // `editor` is in the group the ACL names; `outsider` is in none.
  await admin.query(
    `insert into app.user_groups (workspace_id, user_id, group_name, source)
     values ('default','editor','editors','manual')`,
  );

  for (const u of ["owner", "editor", "outsider"]) await grant(u);
  await grant("outsider_plain", "plain");

  pools = createPools({
    app: p.urls.admin,
    dev: p.urls.dev,
    live: p.urls.live,
    devWrite: p.urls.devWrite,
    liveWrite: p.urls.liveWrite,
  });
  broker = makeBroker(pools, cfg);
}, 120_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

async function countFor(userId: string): Promise<number> {
  const r = await broker.query(makeCtx({ userId }), {
    collection: "content",
    aggregate: [{ fn: "count", field: "id" }],
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  return Number(r.documents[0]!.count_id);
}

describe("the count", () => {
  it("excludes the restricted document for a caller not on its ACL", async () => {
    expect(await countFor("outsider")).toBe(999);
  });

  it("includes it for the user principal on the ACL", async () => {
    expect(await countFor("owner")).toBe(1000);
  });

  it("includes it for a caller in the group on the ACL", async () => {
    expect(await countFor("editor")).toBe(1000);
  });

  it("sum and avg are scoped the same way, not only count", async () => {
    const agg = async (userId: string) => {
      const r = await broker.query(makeCtx({ userId }), {
        collection: "content",
        aggregate: [
          { fn: "sum", field: "weight" },
          { fn: "avg", field: "weight" },
        ],
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      return { sum: Number(r.documents[0]!.sum_weight), avg: Number(r.documents[0]!.avg_weight) };
    };
    // Every weight is 1, so the sum IS the visible count and the average stays 1 either way —
    // which is the point: the average is computed over a scoped population, not corrected after.
    expect((await agg("outsider")).sum).toBe(999);
    expect((await agg("owner")).sum).toBe(1000);
    expect((await agg("outsider")).avg).toBe(1);
  });
});

describe("no ACL row means public", () => {
  it("the other 999 stay readable with no ACL rows at all", async () => {
    const rows = await admin.query(`select count(*)::int as n from data_synth."_acl"`);
    expect(rows.rows[0].n, "exactly one ACL row exists").toBe(1);
    expect(await countFor("outsider")).toBe(999);
  });

  it("a collection without acl: true is untouched", async () => {
    const r = await broker.query(makeCtx({ userId: "outsider_plain" }), {
      collection: "plain",
      aggregate: [{ fn: "count", field: "id" }],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(Number(r.documents[0]!.count_id)).toBe(1);
  });
});

describe("denied means absent", () => {
  it("getDocument on the restricted document is not_found, and is found for a listed principal", async () => {
    const denied = await broker.getDocument(makeCtx({ userId: "outsider" }), {
      collection: "content",
      id: restrictedId,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("not_found");

    const allowed = await broker.getDocument(makeCtx({ userId: "owner" }), {
      collection: "content",
      id: restrictedId,
    });
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
  });

  it("a filtered query cannot reach it either — an ACL is not only an aggregate rule", async () => {
    const r = await broker.query(makeCtx({ userId: "outsider" }), {
      collection: "content",
      fields: ["id", "body"],
      filters: [{ field: "id", op: "eq", value: restrictedId }],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.documents).toHaveLength(0);
  });

  it("searchDocuments never returns it, and the canary reaches no body, error or log line", async () => {
    const cap = captureLogs();
    let bodies: string;
    try {
      const search = await broker.searchDocuments(makeCtx({ userId: "outsider" }), {
        collection: "content",
        q: "secret",
      });
      const doc = await broker.getDocument(makeCtx({ userId: "outsider" }), {
        collection: "content",
        id: restrictedId,
      });
      const query = await broker.query(makeCtx({ userId: "outsider" }), {
        collection: "content",
        fields: ["id", "body"],
        limit: 500,
      });
      bodies = JSON.stringify([search, doc, query]);
    } finally {
      cap.restore();
    }
    expect(bodies).not.toContain(CANARY);
    expect(cap.text()).not.toContain(CANARY);
  });

  it("a listed principal does get the restricted document back from search", async () => {
    const r = await broker.searchDocuments(makeCtx({ userId: "owner" }), {
      collection: "content",
      q: "secret",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.documents.map((d) => d.id)).toContain(restrictedId);
  });

  it("search for a caller not on the ACL returns nothing for the same query", async () => {
    const r = await broker.searchDocuments(makeCtx({ userId: "outsider" }), {
      collection: "content",
      q: "secret",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.documents).toHaveLength(0);
  });
});

describe("the audit row records the membership the decision was made under", () => {
  it("principals are stored, so who-could-read-what is reproducible after a group changes", async () => {
    const r = await broker.query(makeCtx({ userId: "editor" }), {
      collection: "content",
      aggregate: [{ fn: "count", field: "id" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.auditId) throw new Error("expected an audited allow");
    const row = await admin.query<{ principals: string[] }>(
      `select principals from app.audit_events where id = $1`,
      [r.auditId],
    );
    expect(row.rows[0]!.principals).toEqual(["user:editor", "group:editors"]);
  });
});

// Ranked reads. `mode: semantic` and `mode: hybrid` need an embedding column, which only a FILE
// collection has — and v1 refuses `acl: true` on a file collection (config/schema.ts), so the two
// cannot meet through the broker yet. What CAN be pinned now, and is what would break if the
// predicate moved, is where it lands in the statement: inside the `scoped` CTE both RRF branches
// read from, before either ranking and before either LIMIT.
describe("ranked reads: the predicate is inside `scoped`", () => {
  const hybrid = () =>
    buildSelect("dev", { collection: "content", fields: ["id"], limit: 5 }, FIELDS, {
      q: "secret",
      qVector: [0.1, 0.2],
      mode: "hybrid",
      aclPrincipals: ["user:outsider"],
    }).text;

  it("lands in the CTE, not in the outer select", () => {
    const text = hybrid();
    const scoped = text.slice(text.indexOf("with scoped as ("), text.indexOf("), t as ("));
    expect(scoped).toContain(`"_acl"`);
    // …and the ranking CTEs read `scoped`, so they can only rank what survived it.
    expect(text).toContain("from scoped where tsv @@");
    expect(text).toContain("from scoped where embedding is not null");
  });

  it("a plain text search puts it in the same WHERE as the lexical match", () => {
    const text = buildSelect("dev", { collection: "content", fields: ["id"] }, FIELDS, {
      q: "secret",
      searchFields: ["title", "body"],
      mode: "text",
      aclPrincipals: ["user:outsider"],
    }).text;
    expect(text).toMatch(/where .*"_acl".*@@/s);
  });

  it("is absent entirely when no principals are supplied", () => {
    const text = buildSelect("dev", { collection: "plain", fields: ["id"] }, ["id"], {}).text;
    expect(text).not.toContain("_acl");
  });
});
