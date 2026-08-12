import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, DEFAULT_WORKSPACE_ID } from "../src/db/migrate-app";
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

const WORKSPACE_A = DEFAULT_WORKSPACE_ID;
const WORKSPACE_B = "workspace-b";

let p: Provisioned;
let db: Pool;

beforeAll(async () => {
  p = await provision("orgctl");
  db = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(db);
  await db.query(`insert into app.workspaces (id, name) values ($1,'B')`, [WORKSPACE_B]);
}, 60_000);

afterAll(async () => {
  await db.end();
  await p.end();
});

const pendingIn = (workspaceId: string, userId: string, env: "dev" | "live" = "dev") =>
  requestGrant(db, {
    userId,
    collection: "people",
    env,
    workspaceId,
    purposeLabel: "t",
    allowedFields: ["id", "full_name"],
  });

describe("control-plane workspace scoping", () => {
  it("a manager cannot approve another workspace's grant", async () => {
    const id = await pendingIn(WORKSPACE_B, "u1");
    const r = await approveGrant(db, cfg, id, "manager-of-a", { workspaceId: WORKSPACE_A });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown_grant");
    const row = await db.query(`select status from app.grants where id=$1`, [id]);
    expect(row.rows[0].status).toBe("pending"); // untouched
  });

  it("a manager can approve a grant in their own workspace", async () => {
    const id = await pendingIn(WORKSPACE_B, "u2");
    expect((await approveGrant(db, cfg, id, "manager-of-b", { workspaceId: WORKSPACE_B })).ok).toBe(
      true,
    );
  });

  it("a manager cannot deny another workspace's grant", async () => {
    const id = await pendingIn(WORKSPACE_B, "u3");
    expect(await denyGrant(db, id, "manager-of-a", WORKSPACE_A)).toBe(false);
    expect(await denyGrant(db, id, "manager-of-b", WORKSPACE_B)).toBe(true);
  });

  it("a manager cannot revoke another workspace's approved grant", async () => {
    const id = await pendingIn(WORKSPACE_B, "u4");
    await approveGrant(db, cfg, id, "manager-of-b", { workspaceId: WORKSPACE_B });
    expect(await revokeGrant(db, id, "manager-of-a", WORKSPACE_A)).toBe(false);
    expect(await revokeGrant(db, id, "manager-of-b", WORKSPACE_B)).toBe(true);
  });

  it("omitting the workspace scopes to the implicit one — the forgetful path fails closed", async () => {
    const id = await pendingIn(WORKSPACE_B, "u5");
    // No workspaceId argument at all: it must NOT find a grant belonging to workspace B.
    expect(await denyGrant(db, id, "someone")).toBe(false);
    const row = await db.query(`select status from app.grants where id=$1`, [id]);
    expect(row.rows[0].status).toBe("pending");
  });

  it("env:live eligibility does not leak across workspaces", async () => {
    // The same user id, holding an approved live grant in workspace B only.
    const id = await pendingIn(WORKSPACE_B, "shared", "live");
    await approveGrant(db, cfg, id, "manager-of-b", { workspaceId: WORKSPACE_B });

    expect(await hasApprovedLiveGrant(db, "shared", WORKSPACE_B)).toBe(true);
    // In workspace A that same user must not become eligible for an env:live token.
    expect(await hasApprovedLiveGrant(db, "shared", WORKSPACE_A)).toBe(false);
  });
});
