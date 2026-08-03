import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { Pools } from "../src/db/pools";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";

// `audit.enabled: false` is the one supported way to run without a trail, and it is a deliberate
// hole in what used to be an absolute: every decision writes exactly one row.
//
// The property that has to survive is that `auditId: null` still means two different things and
// the caller can tell them apart from the outcome alone. With auditing ON, a null id means the
// insert failed and the decision went unrecorded, so an allow is downgraded to internal_error
// (audit-failure.test.ts holds that end). With auditing OFF, a null id is the configured answer:
// there was never going to be a row, and the allow stands. Collapsing those two would either
// break every verb in a lower environment or silently un-audit a production one.

const collections = {
  people: {
    description: "People",
    writable: true,
    fields: {
      id: { type: "uuid", posture: "allow", pk: true },
      email: { type: "text", posture: { read: "allow", write: "allow" } },
    },
  },
} as const;

const offCfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  audit: { enabled: false },
  collections,
});

// No `audit` key at all — the default has to be "on", or an existing project loses its trail to an
// upgrade.
const defaultCfg: WarehousdConfig = ConfigSchema.parse({ project: "test", collections });

let p: Provisioned, admin: Pool, pools: Pools;
let off: ReturnType<typeof makeBroker>;
let byDefault: ReturnType<typeof makeBroker>;

// Both brokers share one database, so the counts are per user rather than global.
async function auditRows(userId: string): Promise<number> {
  const r = await admin.query<{ n: number }>(
    `select count(*)::int as n from app.audit_events where user_id = $1`,
    [userId],
  );
  return r.rows[0]!.n;
}

async function grantPeople(userId: string): Promise<void> {
  const grantId = await requestGrant(pools.app, {
    userId,
    collection: "people",
    env: "dev",
    orgId: "default",
    purposeLabel: "test",
    allowedFields: ["id", "email"],
  });
  await approveGrant(pools.app, offCfg, grantId, "admin", { verbs: ["read", "create"] });
}

beforeAll(async () => {
  p = await provision("audit-disabled");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, offCfg);
  pools = createPools({
    app: p.urls.admin,
    dev: p.urls.dev,
    live: p.urls.live,
    devWrite: p.urls.devWrite,
    liveWrite: p.urls.liveWrite,
  });

  await grantPeople("audit_off_user");
  await grantPeople("audit_on_user");

  off = makeBroker(pools, offCfg);
  byDefault = makeBroker(pools, defaultCfg);
}, 60_000);

afterAll(async () => {
  await admin?.end();
  await pools?.end();
  await p?.end();
});

describe("audit.enabled: false", () => {
  it("allows a query, writes no row, and says so with a null auditId", async () => {
    const ctx = makeCtx({ userId: "audit_off_user" });
    const r = await off.query(ctx, { collection: "people", fields: ["email"] });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.auditId).toBeNull();
    expect(await auditRows(ctx.userId)).toBe(0);
  });

  it("still refuses, and still records nothing", async () => {
    const ctx = makeCtx({ userId: "audit_off_stranger" });
    const r = await off.query(ctx, { collection: "people", fields: ["email"] });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no_grant");
      expect(r.auditId).toBeNull();
    }
    expect(await auditRows(ctx.userId)).toBe(0);
  });

  it("commits a mutation rather than rolling it back for a row that was never coming", async () => {
    const ctx = makeCtx({ userId: "audit_off_user" });
    const r = await off.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "committed@example.com" },
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.auditId).toBeNull();

    // assertRecorded throws inside withOrg when an allow could not be recorded, which rolls the
    // insert back. Auditing being off is not that case: the write is real.
    const rows = await admin.query(`select 1 from data_synth.people where email = $1`, [
      "committed@example.com",
    ]);
    expect(rows.rowCount).toBe(1);
    expect(await auditRows(ctx.userId)).toBe(0);
  });

  it("leaves the trail on when the key is absent", async () => {
    const ctx = makeCtx({ userId: "audit_on_user" });
    const r = await byDefault.query(ctx, { collection: "people", fields: ["email"] });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.auditId).not.toBeNull();
    expect(await auditRows(ctx.userId)).toBe(1);
  });
});
