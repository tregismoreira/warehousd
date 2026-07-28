import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { generateSynthetic } from "../src/synthetic/generate";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { requestGrant, approveGrant, revokeGrant, denyGrant } from "../src/grants/manage";
import { loadActiveGrant } from "../src/grants/eval";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "t", server: { port: 1 }, synthetic: { documents_per_collection: { people: 8 } },
  collections: { people: { description: "d", fields: {
    id: { type: "uuid", posture: "allow", pk: true },
    full_name: { type: "text", posture: "allow" },
    email: { type: "text", posture: "allow" },
  }}},
};
let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
beforeAll(async () => {
  p = await provision("lifecycle"); admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin); await applyConfig(admin, cfg); await generateSynthetic(admin, cfg, 1);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

it("request→pending→approve(trim+expiry)→query ok→revoke→immediately no_grant", async () => {
  const ctx = { userId: "mia", env: "dev" as const };
  // before approval → no_grant
  const before = await broker.query(ctx, { collection: "people" });
  expect(before.ok).toBe(false);

  const id = await requestGrant(admin, { userId: "mia", collection: "people", env: "dev",
    purposeLabel: "onboarding", allowedFields: ["id", "full_name", "email"] });
  // trim email off on approval, set future expiry
  await approveGrant(admin, id, "marcus",
    { allowedFields: ["id", "full_name"], expiresAt: new Date(Date.parse("2099-01-01")).toISOString() });

  const ok = await broker.query(ctx, { collection: "people", limit: 2 });
  expect(ok.ok).toBe(true);
  if (ok.ok) { expect("email" in ok.documents[0]).toBe(false); expect("full_name" in ok.documents[0]).toBe(true); }

  // requesting the trimmed field is denied
  const denied = await broker.query(ctx, { collection: "people", fields: ["email"] });
  if (!denied.ok) expect(denied.reason).toBe("field_denied");

  // revoke → the very next query (no token/refresh) is no_grant
  await revokeGrant(admin, id, "marcus");
  const after = await broker.query(ctx, { collection: "people" });
  expect(after.ok).toBe(false);
  if (!after.ok) expect(after.reason).toBe("no_grant");
});

it("approving a second grant for the same (user, collection, env) fails (design test 10)", async () => {
  const id1 = await requestGrant(admin, { userId: "u", collection: "people", env: "dev", purposeLabel: "a", allowedFields: ["id"] });
  await approveGrant(admin, id1, "marcus");
  const id2 = await requestGrant(admin, { userId: "u", collection: "people", env: "dev", purposeLabel: "b", allowedFields: ["id"] });
  await expect(approveGrant(admin, id2, "marcus")).rejects.toThrow(/grants_one_active|duplicate key/);
});

it("approveGrant persists documentFilters array", async () => {
  const id = await requestGrant(admin, { userId: "u2", collection: "people", env: "dev", purposeLabel: "p", allowedFields: ["title","content"] });
  await approveGrant(admin, id, "marcus", { documentFilters: [{ field: "path", op: "in", value: ["hr/pto.md"] }] });
  const g = await loadActiveGrant(admin, "u2", "people", "dev");
  expect(g?.documentFilter?.[0]?.op).toBe("in");
});

it("denyGrant returns false for nonexistent grant", async () => {
  const result = await denyGrant(admin, "00000000-0000-0000-0000-000000000000", "marcus");
  expect(result).toBe(false);
});

it("denyGrant returns false for already-denied grant", async () => {
  const id = await requestGrant(admin, { userId: "u3", collection: "people", env: "dev", purposeLabel: "test", allowedFields: ["id"] });
  const denied1 = await denyGrant(admin, id, "marcus");
  expect(denied1).toBe(true);
  const denied2 = await denyGrant(admin, id, "marcus");
  expect(denied2).toBe(false);
});

it("revokeGrant returns false for nonexistent grant", async () => {
  const result = await revokeGrant(admin, "00000000-0000-0000-0000-000000000000", "marcus");
  expect(result).toBe(false);
});

it("revokeGrant returns false for pending grant (not approved)", async () => {
  const id = await requestGrant(admin, { userId: "u4", collection: "people", env: "dev", purposeLabel: "test", allowedFields: ["id"] });
  const revoked = await revokeGrant(admin, id, "marcus");
  expect(revoked).toBe(false);
});

it("denyGrant returns false for approved grant", async () => {
  const id = await requestGrant(admin, { userId: "u5", collection: "people", env: "dev", purposeLabel: "test", allowedFields: ["id"] });
  await approveGrant(admin, id, "marcus");
  const denied = await denyGrant(admin, id, "marcus");
  expect(denied).toBe(false);
});
