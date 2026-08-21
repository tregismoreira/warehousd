import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { admits } from "../src/grants/filters";
import { aclPredicate } from "../src/acl/sql";
import { ACL_COLUMN, ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";
import { makeCtx } from "./helpers/ctx";

// The ACL rule is evaluated twice, exactly as a grant's document filter is: in SQL on the read
// path (`aclPredicate`, ANDed into buildSelect's WHERE) and in process on the write path
// (`aclAdmits`, reached through `admits`). Two evaluators for one rule is a correctness problem —
// whenever they disagree, the same ACL admits a document on read and refuses it on write, or the
// other way round, which is the failure mode filter-parity.test.ts exists for one layer up.
//
// This file is the assertion that they agree, made against a live Postgres rather than against an
// assumption about one. The contract is narrow enough to state exactly: for every (stored ACL,
// principal set) pair, `coalesce(array_length("_acl",1),0) = 0 or "_acl" && $1::text[]` and
// `admits()` return the same boolean.

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;

const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  collections: {
    content: {
      description: "Pages",
      writable: true,
      acl: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

const c = cfg.collections.content!;

beforeAll(async () => {
  p = await provision("acl-parity");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({
    app: p.urls.admin,
    dev: p.urls.dev,
    live: p.urls.live,
    devWrite: p.urls.devWrite,
    liveWrite: p.urls.liveWrite,
  });
  broker = makeBroker(pools, cfg);
}, 90_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

type Case = { label: string; acl: string[] | null; principals: string[] };

const CASES: Case[] = [
  { label: "no ACL row, some principals", acl: null, principals: ["user:a"] },
  { label: "no ACL row, no principals", acl: null, principals: [] },
  { label: "empty ACL — the row exists but names nobody", acl: [], principals: ["user:a"] },
  { label: "exact user match", acl: ["user:a"], principals: ["user:a"] },
  { label: "user miss", acl: ["user:a"], principals: ["user:b"] },
  { label: "group match", acl: ["group:editors"], principals: ["user:b", "group:editors"] },
  { label: "group miss", acl: ["group:editors"], principals: ["user:b", "group:authors"] },
  {
    label: "several principals, one overlaps",
    acl: ["user:x", "group:editors", "user:y"],
    principals: ["user:y"],
  },
  { label: "caller with no principals at all", acl: ["user:a"], principals: [] },
  {
    label: "namespace is significant — a user named like a group is not that group",
    acl: ["group:editors"],
    principals: ["user:editors"],
  },
  {
    label: "prefix collision is not a match",
    acl: ["user:alice"],
    principals: ["user:alice2"],
  },
  {
    label: "duplicate principals on both sides",
    acl: ["user:a", "user:a"],
    principals: ["user:a"],
  },
];

describe("the SQL predicate and admits() agree", () => {
  for (const k of CASES) {
    it(k.label, async () => {
      // What the database says, through the exact clause the read path emits and a bound
      // parameter — the read path's semantics, not a paraphrase of them.
      const sql = await admin.query<{ m: boolean }>(
        `select ${aclPredicate("$2")} as m
         from (select $1::text[] as ${ACL_COLUMN}) t`,
        [k.acl, k.principals],
      );
      const sqlMatch = sql.rows[0]!.m;

      // What the write path says, against a row shaped as the driver hands one over.
      const jsMatch = admits(
        { id: "x", [ACL_COLUMN]: k.acl },
        { documentFilter: [], principals: k.principals },
        c,
      );

      expect(jsMatch, `SQL said ${sqlMatch}, in-process said ${jsMatch}`).toBe(sqlMatch);
    });
  }
});

describe("admits() fails closed on a row that never carried the column", () => {
  it("an absent `_acl` is refused, not read as public", () => {
    // The difference between null and absent is the whole reason `admits` inspects the key rather
    // than the value: null means "no ACL row" and is public; absent means the caller's query did
    // not fetch the column, and reading THAT as public would turn a forgotten join into a leak.
    expect(admits({ id: "x" }, { documentFilter: [], principals: ["user:a"] }, c)).toBe(false);
    expect(admits({ id: "x", [ACL_COLUMN]: null }, { documentFilter: [], principals: [] }, c)).toBe(
      true,
    );
  });

  it("a collection without acl: true never looks", () => {
    const plain = ConfigSchema.parse({
      project: "t",
      collections: {
        plain: {
          description: "d",
          fields: { id: { type: "uuid", posture: "allow", pk: true } },
        },
      },
    }).collections.plain!;
    expect(admits({ id: "x" }, { documentFilter: [], principals: [] }, plain)).toBe(true);
  });

  it("an ACL that is not an array of strings denies", () => {
    // Nothing setDocumentAcl writes looks like this, so it can only come from a row edited
    // directly in the database. An uninterpretable policy denies rather than admits.
    for (const junk of [42, "user:a", [1, 2], [{ user: "a" }]])
      expect(
        admits({ id: "x", [ACL_COLUMN]: junk }, { documentFilter: [], principals: ["user:a"] }, c),
        JSON.stringify(junk),
      ).toBe(false);
  });
});

// The evaluator pair above is pinned against each other. This is the thing an operator cares
// about: one ACL, one document, and the read verb and the write verb agreeing about whether that
// document is in scope. It is what fails if a verb ever stops routing through `admits()`, however
// correct that function is on its own.
describe("one ACL scopes read and write identically", () => {
  let seq = 0;

  // `aclFor` takes the generated user id rather than a literal list, so a case can name the caller
  // without the file having to predict which id the counter is on.
  async function bothPaths(aclFor: (userId: string) => string[] | null, groups: string[]) {
    const userId = `acl_user_${seq++}`;
    const acl = aclFor(userId);
    await admin.query(
      `insert into app.grants (user_id,collection,allowed_fields,env,status,verbs)
       values ($1,'content',array['id','title'],'dev','approved',array['read','update'])`,
      [userId],
    );
    for (const g of groups)
      await admin.query(
        `insert into app.user_groups (workspace_id,user_id,group_name,source) values ('default',$1,$2,'manual')`,
        [userId, g],
      );

    const docId = (
      await admin.query<{ id: string }>(
        `insert into data_synth.content (${R}, id, title) values (${RV}, gen_random_uuid(), 'doc')
         returning id`,
      )
    ).rows[0]!.id;
    if (acl !== null)
      await admin.query(
        `insert into data_synth."_acl" (workspace_id, collection, document_id, principals, updated_by)
         values ('default','content',$1,$2,'test')`,
        [docId, acl],
      );

    const ctx = makeCtx({ userId });
    const read = await broker.query(ctx, {
      collection: "content",
      fields: ["id"],
      filters: [{ field: "id", op: "eq", value: docId }],
    });
    const readReaches = read.ok ? read.documents.length === 1 : `refused:${read.reason}`;

    const write = await broker.mutate(ctx, {
      collection: "content",
      op: "update",
      id: docId,
      values: { title: "doc" },
    });
    const writeReaches = write.ok ? true : `refused:${write.reason}`;

    return { readReaches, writeReaches };
  }

  it("no ACL: both paths reach the document", async () => {
    const r = await bothPaths(() => null, []);
    expect(r.readReaches, "read").toBe(true);
    expect(r.writeReaches, "write").toBe(true);
  });

  it("an ACL naming the caller: both paths reach it", async () => {
    const r = await bothPaths((u) => [`user:${u}`], []);
    expect(r.readReaches, "read").toBe(true);
    expect(r.writeReaches, "write").toBe(true);
  });

  it("an ACL naming somebody else: neither path reaches it", async () => {
    const r = await bothPaths(() => ["user:nobody"], []);
    expect(r.readReaches, "read").toBe(false);
    expect(r.writeReaches, "write").toBe("refused:not_found");
  });

  it("a group the caller is in: both paths reach it", async () => {
    const r = await bothPaths(() => ["group:editors"], ["editors"]);
    expect(r.readReaches, "read").toBe(true);
    expect(r.writeReaches, "write").toBe(true);
  });

  it("a group the caller is not in: neither path reaches it", async () => {
    const r = await bothPaths(() => ["group:editors"], ["authors"]);
    expect(r.readReaches, "read").toBe(false);
    expect(r.writeReaches, "write").toBe("refused:not_found");
  });
});
