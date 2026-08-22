import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { requestGrant, approveGrant } from "../src/grants/manage";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";

// Segregation of duties on the environment where it buys something.
//
// Nothing stopped an approver approving their own live request before this, so "governed" was
// break-glass with extra steps: any manager could hand themselves real data and the audit trail
// would show a decision with one name on both sides of it. `dev` stays exempt on purpose — its
// rows are generated and regenerable, and a rule that makes people wait for a colleague to
// unlock fabricated data is a rule they learn to route around.
const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  collections: {
    people: {
      description: "d",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        full_name: { type: "text", posture: "allow" },
      },
    },
  },
});

let p: Provisioned, admin: Pool;

beforeAll(async () => {
  p = await provision("selfapprove");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
});

afterAll(async () => {
  await admin.end();
  await p.end();
});

async function ask(userId: string, env: "dev" | "live") {
  return requestGrant(admin, {
    userId,
    collection: "people",
    workspaceId: "default",
    env,
    purposeLabel: "t",
    allowedFields: ["id", "full_name"],
  });
}

async function statusOf(id: string): Promise<string> {
  return (await admin.query(`select status from app.grants where id=$1`, [id])).rows[0].status;
}

describe("approveGrant — self-approval", () => {
  it("refuses a live grant approved by the person who asked for it", async () => {
    const id = await ask("marcus", "live");
    const r = await approveGrant(admin, cfg, id, "marcus");
    expect(r).toEqual({ ok: false, error: "self_approval_denied" });
  });

  it("leaves that grant pending, so another approver can still decide it", async () => {
    const id = await ask("lanna", "live");
    await approveGrant(admin, cfg, id, "lanna");
    expect(await statusOf(id)).toBe("pending");

    expect((await approveGrant(admin, cfg, id, "marcus")).ok).toBe(true);
    expect(await statusOf(id)).toBe("approved");
  });

  it("allows self-approval on dev, where the data is generated", async () => {
    const id = await ask("marcus", "dev");
    expect((await approveGrant(admin, cfg, id, "marcus")).ok).toBe(true);
    expect(await statusOf(id)).toBe("approved");
  });

  it("allows a different approver on dev too", async () => {
    const id = await ask("mia", "dev");
    expect((await approveGrant(admin, cfg, id, "marcus")).ok).toBe(true);
    expect(await statusOf(id)).toBe("approved");
  });

  // The check reads the grant's own user_id, not the caller's claim about it, and it runs before
  // the verb rules — so a self-approval is refused for being a self-approval whatever else is
  // wrong with the request.
  it("refuses before validating verbs, so the reason names the real problem", async () => {
    const id = await ask("omar", "live");
    const r = await approveGrant(admin, cfg, id, "omar", { verbs: ["fly"] });
    expect(r).toEqual({ ok: false, error: "self_approval_denied" });
  });

  // Workspace scoping still comes first: a grant in another tenant is not found at all, which must not
  // be reported as a self-approval problem.
  it("still reports an unreachable grant as unknown, not as self-approval", async () => {
    const id = await ask("marcus", "live");
    const r = await approveGrant(admin, cfg, id, "marcus", { workspaceId: "some-other-workspace" });
    expect(r).toEqual({ ok: false, error: "unknown_grant" });
  });
});
