import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import {
  requestGrant,
  approveGrant,
  revokeGrant,
  narrowerThanInherited,
} from "../src/grants/manage";
import { loadActiveGrant, loadActiveGrants } from "../src/grants/eval";
import { setUserGroups } from "../src/acl/manage";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import type { DocumentFilter } from "../src/types";
import { makeCtx } from "./helpers/ctx";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// §P1. Grants resolve through a PRINCIPAL — `user:<id>` or `group:<name>` — so "Litigation can
// read matters" is expressible, onboarding is a group membership rather than a re-approval of
// everything the last paralegal had, and offboarding is one row.
//
// The decision that matters is which grant wins when two match, and the answer is specificity:
// `user:` beats `group:`, then most recently requested. Everything below is about that being true
// and staying reproducible from the audit trail.

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
        base_salary: { type: "numeric", posture: "allow" },
        bank_account: { type: "text", posture: "deny" },
      },
    },
  },
});

const ALL = ["id", "person", "base_salary"];

beforeAll(async () => {
  p = await provision("group-grants");
  app = testPool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
  await app.query(
    `insert into data_synth.salaries (${R}, workspace_id, id, person, base_salary, bank_account)
     values (${RV}, 'default', gen_random_uuid(), 'Ana', 97300, 'GB33')`,
  );
}, 60_000);

afterAll(async () => {
  await app.end();
  await pools.end();
  await p.end();
});

/** Approve a grant for a principal, and hand back its id. */
async function grant(
  principal: string,
  opts: {
    requestedBy?: string;
    fields?: string[];
    verbs?: string[];
    documentFilters?: DocumentFilter[];
    expiresAt?: string;
  } = {},
) {
  const id = await requestGrant(app, {
    userId: opts.requestedBy ?? "admin",
    collection: "salaries",
    env: "dev",
    workspaceId: "default",
    purposeLabel: "test",
    allowedFields: opts.fields ?? ALL,
    principal,
  });
  const r = await approveGrant(app, cfg, id, "approver", {
    verbs: opts.verbs ?? ["read"],
    allowedFields: opts.fields ?? ALL,
    ...(opts.documentFilters ? { documentFilters: opts.documentFilters } : {}),
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
  });
  if (!r.ok) throw new Error(`approve failed: ${r.error} ${r.detail ?? ""}`);
  return { id, warning: r.warning };
}

describe("a user with only a group grant can read", () => {
  it("resolves the grant through the membership, not the user id", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "paralegal-1",
      groups: ["litigation"],
      source: "manual",
    });
    const g = await grant("group:litigation");

    const ctx = makeCtx({ userId: "paralegal-1" });
    const active = await loadActiveGrant(app, ctx, "salaries");
    expect(active?.id).toBe(g.id);
    expect(active?.principal).toBe("group:litigation");

    const res = await broker.query(ctx, { collection: "salaries", fields: ["person"] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.documents[0]?.person).toBe("Ana");
  });

  it("gives nothing to somebody outside the group", async () => {
    const res = await broker.query(makeCtx({ userId: "outsider" }), {
      collection: "salaries",
      fields: ["person"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_grant");
  });

  it("onboarding is a membership, not a re-approval", async () => {
    // The whole point: the second paralegal gets the same access without anybody approving
    // anything for them.
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "paralegal-2",
      groups: ["litigation"],
      source: "manual",
    });
    const active = await loadActiveGrant(app, makeCtx({ userId: "paralegal-2" }), "salaries");
    expect(active?.principal).toBe("group:litigation");
  });
});

describe("a personal grant wins over an inherited one", () => {
  it("takes the user: grant even when the group grant is newer and wider", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "ana",
      groups: ["corporate"],
      source: "manual",
    });
    const personal = await grant("user:ana", { requestedBy: "ana", fields: ["person"] });
    // A group grant requested AFTER the personal one, and wider. Specificity, not recency.
    await grant("group:corporate", { fields: ALL });

    const active = await loadActiveGrant(app, makeCtx({ userId: "ana" }), "salaries");
    expect(active?.id).toBe(personal.id);
    expect(active?.principal).toBe("user:ana");
    expect(active?.allowedFields).toEqual(["person"]);
  });

  // The same assertion with the rows inserted the other way round. Specificity that only held for
  // one insertion order would be recency wearing specificity's name, and the suite above cannot
  // tell the two apart on its own.
  it("takes the user: grant when the group grant is OLDER and wider", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "dora",
      groups: ["tax"],
      source: "manual",
    });
    await grant("group:tax", { fields: ALL });
    const personal = await grant("user:dora", { requestedBy: "dora", fields: ["person"] });

    const active = await loadActiveGrant(app, makeCtx({ userId: "dora" }), "salaries");
    expect(active?.id).toBe(personal.id);
    expect(active?.allowedFields).toEqual(["person"]);
  });

  // The security-critical negative. Merging would silently widen a narrow, purpose-bound personal
  // grant to whatever the group holds, and would leave the audit row unable to name the authority
  // the decision was made under.
  it("does NOT union the two — the wider group grant contributes nothing", async () => {
    const ctx = makeCtx({ userId: "dora" });
    const active = await loadActiveGrant(app, ctx, "salaries");
    expect(active?.allowedFields).not.toContain("base_salary");

    const res = await broker.query(ctx, { collection: "salaries", fields: ["base_salary"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("field_denied");
  });

  it("the batch loader orders identically", async () => {
    const grants = await loadActiveGrants(app, makeCtx({ userId: "ana" }), ["salaries"]);
    // A caller that saw one grant through `query` and another through `changes` would be looking
    // at two different access decisions for the same collection.
    expect(grants.get("salaries")?.principal).toBe("user:ana");
    expect(grants.get("salaries")?.allowedFields).toEqual(["person"]);
  });

  it("narrows access, and approval says so rather than refusing", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "bruno",
      groups: ["corporate"],
      source: "manual",
    });
    const r = await grant("user:bruno", { requestedBy: "bruno", fields: ["person"] });
    // The honest cost of specificity: the personal grant takes away what the group gave.
    expect(r.warning).toMatchObject({ principal: "group:corporate" });
    expect(r.warning?.losing.sort()).toEqual(["base_salary", "id"]);
  });

  it("says nothing when the personal grant is not narrower", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "carla",
      groups: ["corporate"],
      source: "manual",
    });
    const r = await grant("user:carla", { requestedBy: "carla", fields: ALL });
    expect(r.warning).toBeUndefined();
  });

  it("says nothing about a group grant, which can never narrow anything", async () => {
    const n = await narrowerThanInherited(app, {
      userId: "ana",
      collection: "salaries",
      env: "dev",
      workspaceId: "default",
      principal: "group:corporate",
      allowedFields: [],
    });
    expect(n).toBeNull();
  });
});

describe("revoking the group grant removes access", () => {
  it("takes effect on the next call, with no restart", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "temp",
      groups: ["contractors"],
      source: "manual",
    });
    const g = await grant("group:contractors");
    const ctx = makeCtx({ userId: "temp" });
    expect((await broker.query(ctx, { collection: "salaries", fields: ["person"] })).ok).toBe(true);

    // Revoke means revoke — which is the property a UNION of matching grants would have broken.
    expect(await revokeGrant(app, g.id, "approver", "default")).toBe(true);
    const after = await broker.query(ctx, { collection: "salaries", fields: ["person"] });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("no_grant");
  });

  it("removing the membership does the same", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "leaver",
      groups: ["litigation"],
      source: "manual",
    });
    const ctx = makeCtx({ userId: "leaver" });
    expect((await broker.query(ctx, { collection: "salaries", fields: ["person"] })).ok).toBe(true);
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "leaver",
      groups: [],
      source: "manual",
    });
    expect((await broker.query(ctx, { collection: "salaries", fields: ["person"] })).ok).toBe(
      false,
    );
  });
});

describe("the audit row names the winning grant and its principal", () => {
  it("records the group grant's id and principal", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "audited",
      groups: ["litigation"],
      source: "manual",
    });
    const ctx = makeCtx({ userId: "audited" });
    const res = await broker.query(ctx, { collection: "salaries", fields: ["person"] });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const row = await app.query(
      `select grant_id, grant_principal, principals from app.audit_events where id=$1`,
      [res.auditId],
    );
    const active = await loadActiveGrant(app, ctx, "salaries");
    expect(row.rows[0].grant_id).toBe(active?.id);
    // "On what authority" has to stay answerable after the grant is revoked, which is why the
    // principal is recorded beside the id rather than derived from it.
    expect(row.rows[0].grant_principal).toBe("group:litigation");
    // The caller's whole membership set, as it was at that instant, is a separate fact.
    expect(row.rows[0].principals).toContain("group:litigation");
  });
});

describe("a principal must be namespaced", () => {
  it("refuses a bare name rather than guessing", async () => {
    await expect(
      requestGrant(app, {
        userId: "x",
        collection: "salaries",
        env: "dev",
        workspaceId: "default",
        purposeLabel: "t",
        allowedFields: ALL,
        principal: "litigation",
      }),
    ).rejects.toThrow(/invalid grant principal/);
  });

  it("defaults to the requester when none is given", async () => {
    const id = await requestGrant(app, {
      userId: "defaulted",
      collection: "salaries",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "t",
      allowedFields: ALL,
    });
    const r = await app.query(`select principal from app.grants where id=$1`, [id]);
    expect(r.rows[0].principal).toBe("user:defaulted");
  });
});

// The client ceiling narrows FIRST, before any principal is looked at. Otherwise a restricted
// client would inherit, through a group, exactly the collections it was configured not to reach.
describe("the collection ceiling still narrows first", () => {
  it("gives nothing outside the ceiling, group grant or not", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "capped",
      groups: ["litigation"],
      source: "manual",
    });
    // Inside the ceiling the inherited grant resolves as usual...
    expect((await loadActiveGrant(app, makeCtx({ userId: "capped" }), "salaries"))?.principal).toBe(
      "group:litigation",
    );
    // ...outside it, the same grant resolves to nothing at all.
    const capped = makeCtx({ userId: "capped", allowedCollections: ["something_else"] });
    expect(await loadActiveGrant(app, capped, "salaries")).toBeNull();
    const res = await broker.query(capped, { collection: "salaries", fields: ["person"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_grant");
  });
});

// Per-grant expiry is a property of the GRANT, not of the principal that holds it. A group grant
// that outlived its expiry would be the one place the clause did not apply.
describe("an expired group grant grants nothing", () => {
  it("stops resolving the moment it lapses, with no restart", async () => {
    await setUserGroups(app, {
      workspaceId: "default",
      userId: "seconded",
      groups: ["secondment"],
      source: "manual",
    });
    const g = await grant("group:secondment", {
      expiresAt: new Date(Date.now() + 1_500).toISOString(),
    });
    const ctx = makeCtx({ userId: "seconded" });
    expect((await loadActiveGrant(app, ctx, "salaries"))?.id).toBe(g.id);

    // Moved into the past rather than waited out: the clause under test is
    // `expires_at > now()`, and a suite that sleeps for it is a suite that flakes.
    await app.query(`update app.grants set expires_at = now() - interval '1 minute' where id=$1`, [
      g.id,
    ]);
    expect(await loadActiveGrant(app, ctx, "salaries")).toBeNull();
    const res = await broker.query(ctx, { collection: "salaries", fields: ["person"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_grant");
  });
});

// `$self` is bound per CALLER, not per grant. A group grant scoped to "rows you own" has to mean
// something different for each member of the group, or the sentinel is decorative.
describe("$self in a group grant binds to the caller", () => {
  it("scopes each member of the group to their own documents", async () => {
    await app.query(
      `insert into data_synth.salaries (${R}, workspace_id, id, person, base_salary, bank_account)
       values (${RV}, 'default', gen_random_uuid(), 'owner-a', 1, 'x'),
              (${RV}, 'default', gen_random_uuid(), 'owner-b', 2, 'y')`,
    );
    for (const u of ["owner-a", "owner-b"])
      await setUserGroups(app, {
        workspaceId: "default",
        userId: u,
        groups: ["owners"],
        source: "manual",
      });
    await grant("group:owners", {
      fields: ["id", "person", "base_salary"],
      documentFilters: [{ field: "person", op: "eq", value: "$self" }],
    });

    for (const who of ["owner-a", "owner-b"]) {
      const ctx = makeCtx({ userId: who });
      const active = await loadActiveGrant(app, ctx, "salaries");
      // Bound at load time, so the stored filter stays `$self` and two callers get two answers.
      expect(active?.documentFilter).toEqual([{ field: "person", op: "eq", value: who }]);
      const res = await broker.query(ctx, { collection: "salaries", fields: ["person"] });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.documents.map((d) => d.person)).toEqual([who]);
    }
  });
});

// The lookup shape changed — `principal = any($1)` replaced `user_id = $1` — so the index that
// served the old predicate does not serve this one. A sequential scan over app.grants is a scan
// on the hot path of every single governed call.
describe("the resolution query is indexed", () => {
  it("plans an index scan rather than a sequential one", async () => {
    // A realistic table: the planner is right to scan fifty rows, so fifty rows prove nothing.
    // Decided history rather than live access, which is what a mature deployment looks like.
    await app.query(
      `insert into app.grants (user_id, collection, env, workspace_id, purpose_label, allowed_fields,
                               principal, status, requested_at)
       select 'bulk-' || i, 'salaries', 'dev', 'default', 'bulk', $1,
              'user:bulk-' || i, case when i % 20 = 0 then 'approved' else 'revoked' end, now()
       from generate_series(1, 4000) as i`,
      [ALL],
    );
    await app.query(`analyze app.grants`);

    const plan = await app.query<{ "QUERY PLAN": string }>(
      `explain select id from app.grants
       where principal = any($1) and collection=$2 and env=$3 and workspace_id=$4
         and status='approved' and (expires_at is null or expires_at > now())`,
      [["user:ana", "group:corporate"], "salaries", "dev", "default"],
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    expect(text).not.toMatch(/Seq Scan on grants/);
  });
});
