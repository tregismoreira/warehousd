import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, DEFAULT_ORG_ID } from "../src/db/migrate-app";
import { requestGrant, approveGrant, denyGrant, revokeGrant } from "../src/grants/manage";
import { hasApprovedLiveGrant } from "../src/oauth/client-policies";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";

// The data plane has a view predicate and an RLS policy standing behind it. The CONTROL plane
// has neither: app.grants is read and written directly. These are the tests for that half.
const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  collections: {
    people: {
      description: "dir",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        full_name: { type: "text", posture: "allow" },
      },
    },
  },
});

const ORG_A = DEFAULT_ORG_ID;
const ORG_B = "org-b";

let p: Provisioned;
let db: Pool;

beforeAll(async () => {
  p = await provision("orgctl");
  db = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(db);
  await db.query(`insert into app.organizations (id, name) values ($1,'B')`, [ORG_B]);
}, 60_000);

afterAll(async () => {
  await db.end();
  await p.end();
});

const pendingIn = (orgId: string, userId: string, env: "dev" | "live" = "dev") =>
  requestGrant(db, {
    userId,
    collection: "people",
    env,
    orgId,
    purposeLabel: "t",
    allowedFields: ["id", "full_name"],
  });

describe("control-plane org scoping", () => {
  it("a manager cannot approve another org's grant", async () => {
    const id = await pendingIn(ORG_B, "u1");
    const r = await approveGrant(db, cfg, id, "manager-of-a", { orgId: ORG_A });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown_grant");
    const row = await db.query(`select status from app.grants where id=$1`, [id]);
    expect(row.rows[0].status).toBe("pending"); // untouched
  });

  it("a manager can approve a grant in their own org", async () => {
    const id = await pendingIn(ORG_B, "u2");
    expect((await approveGrant(db, cfg, id, "manager-of-b", { orgId: ORG_B })).ok).toBe(true);
  });

  it("a manager cannot deny another org's grant", async () => {
    const id = await pendingIn(ORG_B, "u3");
    expect(await denyGrant(db, id, "manager-of-a", ORG_A)).toBe(false);
    expect(await denyGrant(db, id, "manager-of-b", ORG_B)).toBe(true);
  });

  it("a manager cannot revoke another org's approved grant", async () => {
    const id = await pendingIn(ORG_B, "u4");
    await approveGrant(db, cfg, id, "manager-of-b", { orgId: ORG_B });
    expect(await revokeGrant(db, id, "manager-of-a", ORG_A)).toBe(false);
    expect(await revokeGrant(db, id, "manager-of-b", ORG_B)).toBe(true);
  });

  it("omitting the org scopes to the implicit one — the forgetful path fails closed", async () => {
    const id = await pendingIn(ORG_B, "u5");
    // No orgId argument at all: it must NOT find a grant belonging to org B.
    expect(await denyGrant(db, id, "someone")).toBe(false);
    const row = await db.query(`select status from app.grants where id=$1`, [id]);
    expect(row.rows[0].status).toBe("pending");
  });

  it("env:live eligibility does not leak across orgs", async () => {
    // The same user id, holding an approved live grant in org B only.
    const id = await pendingIn(ORG_B, "shared", "live");
    await approveGrant(db, cfg, id, "manager-of-b", { orgId: ORG_B });

    expect(await hasApprovedLiveGrant(db, "shared", ORG_B)).toBe(true);
    // In org A that same user must not become eligible for an env:live token.
    expect(await hasApprovedLiveGrant(db, "shared", ORG_A)).toBe(false);
  });
});
