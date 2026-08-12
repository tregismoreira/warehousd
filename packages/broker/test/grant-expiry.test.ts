import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import {
  requestGrant,
  approveGrant,
  resolveExpiry,
  expiringGrants,
  accessReview,
} from "../src/grants/manage";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// §P7. `expires_at` was enforced at query time and rendered in two tables, and that was the whole
// lifecycle: no default, no expiring-soon surface, no re-attestation. Access granted for a one-off
// purpose outlived the purpose unless somebody remembered it.

const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

let p: Provisioned, app: Pool, pools: ReturnType<typeof createPools>;
let broker: ReturnType<typeof makeBroker>;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    salaries: {
      description: "Salaries",
      // Thirty days, because the answer is not uniform across collections.
      grant_expiry_days: 30,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        band: { type: "numeric", posture: "allow" },
      },
    },
    announcements: {
      description: "Announcements",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: "allow" },
      },
    },
  },
});

beforeAll(async () => {
  p = await provision("grant-expiry");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
  await app.query(
    `insert into data_synth.salaries (${R}, workspace_id, id, band)
     values (${RV}, 'default', gen_random_uuid(), 100000)`,
  );
}, 60_000);

afterAll(async () => {
  await app.end();
  await pools.end();
  await p.end();
});

async function grant(
  userId: string,
  collection: string,
  opts: { expiresAt?: string } = {},
): Promise<string> {
  const id = await requestGrant(app, {
    userId,
    collection,
    env: "dev",
    workspaceId: "default",
    purposeLabel: "t",
    allowedFields: ["id"],
  });
  const r = await approveGrant(app, cfg, id, "boss", { allowedFields: ["id"], ...opts });
  if (!r.ok) throw new Error(r.error);
  return id;
}

async function expiresAtOf(id: string): Promise<Date | null> {
  const r = await app.query<{ expires_at: Date | null }>(
    `select expires_at from app.grants where id=$1`,
    [id],
  );
  return r.rows[0]!.expires_at;
}

describe("resolveExpiry", () => {
  it("takes the collection's default when the approver names none", () => {
    const at = resolveExpiry(cfg, "salaries", undefined);
    expect(at).not.toBeNull();
    const days = (Date.parse(at!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it("leaves a collection with no default alone", () => {
    // A public collection has no reason to expire, which is what every collection did before.
    expect(resolveExpiry(cfg, "announcements", undefined)).toBeNull();
  });

  it("never overrides the approver's own choice", () => {
    const explicit = "2030-01-01T00:00:00.000Z";
    expect(resolveExpiry(cfg, "salaries", explicit)).toBe(explicit);
  });
});

describe("approveGrant applies the default", () => {
  it("stamps an expiry on a collection that declares one", async () => {
    const at = await expiresAtOf(await grant("a", "salaries"));
    expect(at).not.toBeNull();
  });

  it("leaves one that does not", async () => {
    expect(await expiresAtOf(await grant("b", "announcements"))).toBeNull();
  });

  it("keeps honouring an expired grant's refusal at query time", async () => {
    const id = await grant("c", "salaries", { expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await expiresAtOf(id)).not.toBeNull();
    const res = await broker.query(makeCtx({ userId: "c" }), { collection: "salaries" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_grant");
  });
});

describe("expiringGrants", () => {
  it("finds the ones lapsing inside the window, soonest first", async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await grant("soon_two", "announcements", { expiresAt: soon });
    await grant("soon_five", "announcements", { expiresAt: later });

    const rows = await expiringGrants(app, { within: 7 });
    const users = rows.map((r) => r.userId);
    expect(users.indexOf("soon_two")).toBeLessThan(users.indexOf("soon_five"));
  });

  it("excludes one that has already lapsed — it is not expiring, it is gone", async () => {
    await grant("gone", "announcements", { expiresAt: "2000-01-01T00:00:00.000Z" });
    const rows = await expiringGrants(app, { within: 7 });
    expect(rows.some((r) => r.userId === "gone")).toBe(false);
  });

  it("excludes one outside the window and one with no expiry at all", async () => {
    await grant("far", "announcements", {
      expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    });
    await grant("never", "announcements");
    const rows = await expiringGrants(app, { within: 7 });
    expect(rows.some((r) => r.userId === "far")).toBe(false);
    expect(rows.some((r) => r.userId === "never")).toBe(false);
  });
});

describe("accessReview", () => {
  it("reports a grant nobody has exercised as never used", async () => {
    const id = await grant("unused", "announcements");
    // Backdate the approval so it falls inside the review window.
    await app.query(`update app.grants set decided_at = now() - interval '200 days' where id=$1`, [
      id,
    ]);
    const rows = await accessReview(app, { olderThanDays: 90 });
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.lastUsedAt).toBeNull();
    expect(row!.uses).toBe(0);
  });

  it("reports when a grant was last exercised, from the audit trail", async () => {
    const id = await grant("used", "salaries");
    await app.query(`update app.grants set decided_at = now() - interval '200 days' where id=$1`, [
      id,
    ]);
    // The data was already there: the grant id has been on every audit row since audit/decision.ts
    // started passing the grant rather than its id.
    const res = await broker.query(makeCtx({ userId: "used" }), { collection: "salaries" });
    expect(res.ok).toBe(true);

    const row = (await accessReview(app, { olderThanDays: 90 })).find((r) => r.id === id);
    expect(row?.lastUsedAt).not.toBeNull();
    expect(row!.uses).toBeGreaterThan(0);
  });

  it("puts never-used grants first — the easiest revoke a reviewer will make", async () => {
    const rows = await accessReview(app, { olderThanDays: 90 });
    const firstUsed = rows.findIndex((r) => r.lastUsedAt !== null);
    const lastUnused = rows.map((r) => r.lastUsedAt).lastIndexOf(null);
    if (firstUsed !== -1 && lastUnused !== -1) expect(lastUnused).toBeLessThan(firstUsed);
  });

  it("ignores a grant younger than the window", async () => {
    const id = await grant("fresh", "announcements");
    expect((await accessReview(app, { olderThanDays: 90 })).some((r) => r.id === id)).toBe(false);
  });
});
