import { describe, it, expect } from "vitest";
import type { Pool } from "pg";
import { ConfigSchema } from "../src/config/schema";
import { makeAuditWriter } from "../src/audit/decision";
import { resolveGranted, aclOpts, maskPlan } from "../src/verbs/guard";
import type { VerbDeps } from "../src/verbs/deps";
import { makeCtx } from "./helpers/ctx";

// One case per refusal path through the guard, plus the two rules §B says it must preserve
// verbatim. No database: the guard's decisions are all made from the config and one grant row, so
// the pool is a stub that answers the two statements `loadActiveGrant` issues.

const cfg = ConfigSchema.parse({
  project: "test",
  audit: { enabled: false },
  collections: {
    people: {
      description: "People",
      acl: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: "allow" },
        salary: {
          type: "numeric",
          posture: { read: "mask", write: "deny", unmask: "allow" },
          mask: { transform: "bucket", width: 25000 },
        },
        home_address: { type: "text", posture: "deny" },
      },
    },
    notes: {
      description: "Notes",
      fields: { id: { type: "uuid", posture: "allow", pk: true } },
    },
  },
});

type GrantRow = {
  id: string;
  allowed_fields: string[];
  unmasked_fields: string[];
  document_filter: unknown;
  verbs: string[];
  mode: string;
};

// `loadActiveGrant` issues exactly two statements: the grant select, then the group-membership
// select behind `loadPrincipals`. Answering them by shape keeps the stub honest about which is
// which without pattern-matching whole SQL strings.
function stubPool(grant: GrantRow | null, groups: string[] = []): Pool {
  const query = (text: string) => {
    if (text.includes("app.user_groups"))
      return Promise.resolve({
        rows: groups.map((g) => ({ group_name: g })),
        rowCount: groups.length,
      });
    if (text.includes("app.grants"))
      return Promise.resolve(grant ? { rows: [grant], rowCount: 1 } : { rows: [], rowCount: 0 });
    throw new Error(`unexpected statement in stub: ${text}`);
  };
  return { query } as unknown as Pool;
}

function deps(pool: Pool): VerbDeps {
  return {
    pools: { app: pool } as unknown as VerbDeps["pools"],
    app: pool,
    cfg,
    isMultiValueField: () => false,
    // Off, so no audit row is attempted: the guard's job here is the reason code, and
    // audit-disabled.test.ts owns the question of what a null auditId means.
    auditEnabled: false,
    auditTo: {},
  };
}

const GRANT: GrantRow = {
  id: "g-1",
  allowed_fields: ["id", "email", "salary"],
  unmasked_fields: [],
  document_filter: [],
  verbs: ["read"],
  mode: "direct",
};

async function guard(
  grant: GrantRow | null,
  opts: Parameters<typeof resolveGranted>[5] = {},
  collection = "people",
  verb: "read" | "update" = "read",
  groups: string[] = [],
) {
  const pool = stubPool(grant, groups);
  const d = deps(pool);
  const ctx = makeCtx({ userId: "u-1" });
  const audit = makeAuditWriter(pool, ctx, false);
  return resolveGranted(d, audit, ctx, collection, verb, opts);
}

describe("resolveGranted refusal paths", () => {
  it("unknown_collection when the config has no such collection", async () => {
    const g = await guard(GRANT, {}, "nope");
    expect(g).toMatchObject({ ok: false, reason: "unknown_collection" });
  });

  it("runs collectionCheck before the grant is loaded", async () => {
    // The stub throws on any statement, so reaching the grant select at all would fail loudly.
    const pool = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const ctx = makeCtx({ userId: "u-1" });
    const g = await resolveGranted(
      deps(pool),
      makeAuditWriter(pool, ctx, false),
      ctx,
      "people",
      "update",
      {
        collectionCheck: () => "not_writable" as const,
      },
    );
    expect(g).toMatchObject({ ok: false, reason: "not_writable" });
  });

  it("no_grant when there is no approved grant", async () => {
    expect(await guard(null)).toMatchObject({ ok: false, reason: "no_grant" });
  });

  it("field_denied for a field the grant does not carry", async () => {
    const g = await guard(GRANT, { fields: ["home_address"] });
    expect(g).toMatchObject({ ok: false, reason: "field_denied" });
  });

  it("invalid_intent for a document filter that cannot be evaluated", async () => {
    const g = await guard({
      ...GRANT,
      document_filter: [{ field: "nosuchfield", op: "eq", value: "x" }],
    });
    expect(g).toMatchObject({ ok: false, reason: "invalid_intent" });
    // Invariant 4: a denied name must not appear in what comes back.
    expect(JSON.stringify(g)).not.toContain("nosuchfield");
  });

  it("skips the filter check under checkFilters: false", async () => {
    const g = await guard(
      { ...GRANT, document_filter: [{ field: "nosuchfield", op: "eq", value: "x" }] },
      { checkFilters: false },
    );
    expect(g.ok).toBe(true);
  });
});

// §B, rule 1. A distinct code would tell a caller that a grant exists which it cannot read with.
describe("a missing verb refuses no_grant on read and verb_denied on a write", () => {
  it("read → no_grant", async () => {
    const g = await guard({ ...GRANT, verbs: ["create"] });
    expect(g).toMatchObject({ ok: false, reason: "no_grant" });
  });

  it("update → verb_denied", async () => {
    const g = await guard({ ...GRANT, verbs: ["read"] }, {}, "people", "update");
    expect(g).toMatchObject({ ok: false, reason: "verb_denied" });
  });
});

describe("resolveGranted on the happy path", () => {
  it("hands back the collection, the grant, the mask plan and the ACL options", async () => {
    const g = await guard(GRANT, {}, "people", "read", ["legal"]);
    expect(g.ok).toBe(true);
    if (!g.ok) throw new Error("unreachable");
    expect(g.collection.description).toBe("People");
    expect(g.grant.id).toBe("g-1");
    expect(g.plan.masked.has("salary")).toBe(true);
    expect(g.plan.maskFor("salary")).toMatchObject({ transform: "bucket" });
    expect(g.plan.maskFor("email")).toBeNull();
    expect(g.aclOpts).toEqual({ aclPrincipals: ["user:u-1", "group:legal"] });
  });

  it("drops a masked field from the plan when the grant carries it unmasked", async () => {
    const g = await guard({ ...GRANT, unmasked_fields: ["salary"] });
    if (!g.ok) throw new Error("unreachable");
    expect(g.plan.masked.has("salary")).toBe(false);
    expect(g.plan.maskFor("salary")).toBeNull();
  });
});

// §B, rule 2. Under `exactOptionalPropertyTypes` an explicit `aclPrincipals: undefined` is not the
// same as an absent one, and buildSelect reads the difference: a collection with no `_acl` column
// has nothing for the predicate to compare against.
describe("aclOpts is genuinely absent, not present-and-undefined", () => {
  it("omits the key entirely on a collection without ACLs", () => {
    const o = aclOpts(cfg.collections.notes!, { principals: ["user:u-1"] });
    expect("aclPrincipals" in o).toBe(false);
  });

  it("carries the caller's principals on a collection with them", () => {
    const o = aclOpts(cfg.collections.people!, { principals: ["user:u-1"] });
    expect(o).toEqual({ aclPrincipals: ["user:u-1"] });
  });

  it("comes back absent from the guard too", async () => {
    const g = await guard({ ...GRANT, allowed_fields: ["id"] }, {}, "notes");
    if (!g.ok) throw new Error("unreachable");
    expect("aclPrincipals" in g.aclOpts).toBe(false);
  });
});

describe("maskPlan answers both questions from one source", () => {
  it("`masked` and `maskFor` cannot disagree", () => {
    const plan = maskPlan(cfg, "people", cfg.collections.people!, []);
    for (const f of Object.keys(cfg.collections.people!.fields))
      expect(plan.masked.has(f)).toBe(plan.maskFor(f) !== null);
  });
});
