import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import { setUserGroups } from "../src/acl/manage";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// §P5. "Why can't Ana see salaries.base_salary?" had no answer anywhere. Refusal codes are opaque
// to the model on purpose; the human console inherited that opacity for no reason.

const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

let p: Provisioned, app: Pool, pools: ReturnType<typeof createPools>;
let broker: ReturnType<typeof makeBroker>;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    salaries: {
      description: "Salaries",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        person: { type: "text", posture: "allow" },
        dept: { type: "text", posture: "allow" },
        salary_band: {
          type: "numeric",
          posture: { read: "mask", write: "deny", unmask: "allow" },
          mask: { transform: "bucket", width: 25000 },
        },
        bank_account: { type: "text", posture: "deny" },
      },
    },
  },
});

async function user(id: string, role: string) {
  await app.query(
    `insert into app."user" (id, name, email, "emailVerified", role, "orgId", "createdAt", "updatedAt")
     values ($1,$1,$1||'@t.local',true,$2,'default',now(),now())
     on conflict (id) do update set role=excluded.role`,
    [id, role],
  );
}

beforeAll(async () => {
  p = await provision("explain-access");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);

  // Better Auth owns app."user" in the real stack; here the rows are made directly, because what
  // is under test is the role check reading them.
  await app.query(`create table if not exists app."user" (
    id text primary key, name text, email text, "emailVerified" boolean,
    role text, "orgId" text not null default 'default',
    "createdAt" timestamptz, "updatedAt" timestamptz)`);
  await user("boss", "manager");
  await user("ana", "member");
  await user("mia", "member");

  for (const dept of ["Legal", "Legal", "Engineering"])
    await app.query(
      `insert into data_synth.salaries (${R}, org_id, id, person, dept, salary_band, bank_account)
       values (${RV}, 'default', gen_random_uuid(), 'P', $1, 97300, 'GB33')`,
      [dept],
    );
}, 60_000);

afterAll(async () => {
  await app.end();
  await pools.end();
  await p.end();
});

async function grantTo(principal: string, fields: string[], opts: { unmasked?: string[] } = {}) {
  const id = await requestGrant(app, {
    userId: "boss",
    collection: "salaries",
    env: "dev",
    orgId: "default",
    purposeLabel: "t",
    allowedFields: fields,
    principal,
  });
  const r = await approveGrant(app, cfg, id, "boss", {
    allowedFields: fields,
    ...(opts.unmasked ? { unmaskedFields: opts.unmasked } : {}),
  });
  if (!r.ok) throw new Error(`${r.error} ${r.detail ?? ""}`);
  return id;
}

describe("explainAccess is not reachable through a grant", () => {
  it("refuses a member asking about somebody else", async () => {
    const res = await broker.explainAccess(makeCtx({ userId: "mia" }), "salaries", "ana");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_authorized");
  });

  it("lets a member ask about themselves — 'I can't see X' has to be self-diagnosable", async () => {
    const res = await broker.explainAccess(makeCtx({ userId: "mia" }), "salaries", "mia");
    expect(res.ok).toBe(true);
  });

  it("lets a manager ask about anybody", async () => {
    const res = await broker.explainAccess(makeCtx({ userId: "boss" }), "salaries", "ana");
    expect(res.ok).toBe(true);
  });

  it("refuses an unknown collection", async () => {
    const res = await broker.explainAccess(makeCtx({ userId: "boss" }), "nope", "ana");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown_collection");
  });
});

describe("it names the first rule that said no", () => {
  it("posture for a denied field, no_grant before one exists", async () => {
    const res = await broker.explainAccess(makeCtx({ userId: "boss" }), "salaries", "ana");
    if (!res.ok) throw new Error("unreachable");
    const by = new Map(res.fields.map((f) => [f.field, f]));

    // `deny` is the hard tier: no grant can ever carry it, so the answer is the config, not the
    // grant — and telling the manager that is the difference between "ask for access" and "edit
    // warehousd.yml".
    expect(by.get("bank_account")).toMatchObject({
      posture: "deny",
      grantable: false,
      blockedBy: "posture",
      effect: "none",
    });
    // Grantable, but there is no grant yet.
    expect(by.get("person")).toMatchObject({ grantable: true, blockedBy: "no_grant" });
    expect(res.grant).toBeNull();
    expect(res.matchedDocuments).toBeNull();
  });

  it("not_in_grant for a field the grant leaves out, masked for one it carries transformed", async () => {
    await grantTo("user:ana", ["id", "person", "salary_band"]);
    const res = await broker.explainAccess(makeCtx({ userId: "boss" }), "salaries", "ana");
    if (!res.ok) throw new Error("unreachable");
    const by = new Map(res.fields.map((f) => [f.field, f]));

    expect(by.get("person")).toMatchObject({ granted: true, blockedBy: null, effect: "raw" });
    expect(by.get("dept")).toMatchObject({ granted: false, blockedBy: "not_in_grant" });
    // Three different problems with three different people who can fix them.
    expect(by.get("salary_band")).toMatchObject({
      granted: true,
      blockedBy: "masked",
      effect: "masked",
      unmaskable: true,
      unmasked: false,
    });
    expect(by.get("bank_account")?.blockedBy).toBe("posture");
  });

  it("reports raw once the grant carries the unmask", async () => {
    await grantTo("user:mia", ["id", "salary_band"], { unmasked: ["salary_band"] });
    const res = await broker.explainAccess(makeCtx({ userId: "mia" }), "salaries", "mia");
    if (!res.ok) throw new Error("unreachable");
    const band = res.fields.find((f) => f.field === "salary_band");
    expect(band).toMatchObject({ unmasked: true, blockedBy: null, effect: "raw" });
  });
});

describe("it makes §P1's specificity rule legible", () => {
  it("names the grant, its principal, and every principal the subject holds", async () => {
    await setUserGroups(app, {
      orgId: "default",
      userId: "carl",
      groups: ["legal"],
      source: "manual",
    });
    await user("carl", "member");
    const id = await grantTo("group:legal", ["id", "person"]);

    const res = await broker.explainAccess(makeCtx({ userId: "boss" }), "salaries", "carl");
    if (!res.ok) throw new Error("unreachable");
    expect(res.grant).toMatchObject({ id, principal: "group:legal" });
    // "Inherited, from this group" rather than "somehow".
    expect(res.grant?.via).toEqual(["user:carl", "group:legal"]);
  });
});

describe("it counts the documents the grant actually reaches", () => {
  it("counts through the grant's document filter, not the whole collection", async () => {
    const id = await requestGrant(app, {
      userId: "boss",
      collection: "salaries",
      env: "dev",
      orgId: "default",
      purposeLabel: "t",
      allowedFields: ["id", "person", "dept"],
      principal: "user:scoped",
    });
    const r = await approveGrant(app, cfg, id, "boss", {
      allowedFields: ["id", "person", "dept"],
      documentFilters: [{ field: "dept", op: "eq", value: "Legal" }],
    });
    expect(r.ok).toBe(true);
    await user("scoped", "member");

    const res = await broker.explainAccess(makeCtx({ userId: "boss" }), "salaries", "scoped");
    if (!res.ok) throw new Error("unreachable");
    // Two of the three rows are Legal. A predicate that scopes access and one that matches nothing
    // are indistinguishable without this number.
    expect(res.matchedDocuments).toBe(2);
  });
});

describe("it never returns a field value", () => {
  it("describes the shape of the policy and nothing stored", async () => {
    const res = await broker.explainAccess(makeCtx({ userId: "boss" }), "salaries", "ana");
    // 'GB33' is the bank_account of every seeded row — the one value a denied field holds.
    expect(JSON.stringify(res)).not.toContain("GB33");
    expect(JSON.stringify(res)).not.toContain("97300");
  });
});
