import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
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
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
  await app.query(
    `insert into data_synth.salaries (${R}, org_id, id, person, base_salary, bank_account)
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
  opts: { requestedBy?: string; fields?: string[]; verbs?: string[] } = {},
) {
  const id = await requestGrant(app, {
    userId: opts.requestedBy ?? "admin",
    collection: "salaries",
    env: "dev",
    orgId: "default",
    purposeLabel: "test",
    allowedFields: opts.fields ?? ALL,
    principal,
  });
  const r = await approveGrant(app, cfg, id, "approver", {
    verbs: opts.verbs ?? ["read"],
    allowedFields: opts.fields ?? ALL,
  });
  if (!r.ok) throw new Error(`approve failed: ${r.error} ${r.detail ?? ""}`);
  return { id, warning: r.warning };
}

describe("a user with only a group grant can read", () => {
  it("resolves the grant through the membership, not the user id", async () => {
    await setUserGroups(app, {
      orgId: "default",
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
      orgId: "default",
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
      orgId: "default",
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

  it("the batch loader orders identically", async () => {
    const grants = await loadActiveGrants(app, makeCtx({ userId: "ana" }), ["salaries"]);
    // A caller that saw one grant through `query` and another through `changes` would be looking
    // at two different access decisions for the same collection.
    expect(grants.get("salaries")?.principal).toBe("user:ana");
    expect(grants.get("salaries")?.allowedFields).toEqual(["person"]);
  });

  it("narrows access, and approval says so rather than refusing", async () => {
    await setUserGroups(app, {
      orgId: "default",
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
      orgId: "default",
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
      orgId: "default",
      principal: "group:corporate",
      allowedFields: [],
    });
    expect(n).toBeNull();
  });
});

describe("revoking the group grant removes access", () => {
  it("takes effect on the next call, with no restart", async () => {
    await setUserGroups(app, {
      orgId: "default",
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
      orgId: "default",
      userId: "leaver",
      groups: ["litigation"],
      source: "manual",
    });
    const ctx = makeCtx({ userId: "leaver" });
    expect((await broker.query(ctx, { collection: "salaries", fields: ["person"] })).ok).toBe(true);
    await setUserGroups(app, { orgId: "default", userId: "leaver", groups: [], source: "manual" });
    expect((await broker.query(ctx, { collection: "salaries", fields: ["person"] })).ok).toBe(
      false,
    );
  });
});

describe("the audit row names the winning grant and its principal", () => {
  it("records the group grant's id and principal", async () => {
    await setUserGroups(app, {
      orgId: "default",
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
        orgId: "default",
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
      orgId: "default",
      purposeLabel: "t",
      allowedFields: ALL,
    });
    const r = await app.query(`select principal from app.grants where id=$1`, [id]);
    expect(r.rows[0].principal).toBe("user:defaulted");
  });
});
