import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { BrokerContext } from "@warehousd/broker";
import { loadConfig, requestGrant, approveGrant } from "@warehousd/broker";
import { setupWebDbWithData } from "./helpers/web-db";
import { getAppPool, getBroker } from "../app/lib/broker";

// examples/harbor/warehousd.yml masks `matters.client.select.primary_contact_email` through a
// relation to `clients` (`posture: { read: mask, write: deny }`, `mask: { transform: domain }`).
// The only test naming that field, admin-collections.integration.test.ts, asserts the
// describe_collection SHAPE only — never a live document — so someone flipping the posture to
// `allow` in harbor's own YAML would go undetected. This queries a real seeded document instead.
//
// examples/harbor/seed/live.ts seeds two real addresses, both with the same local part
// ("contact"), which is why the negative assertion below checks the full seeded address rather
// than that substring alone — "contact" alone also occurs inside the field name
// "primary_contact_email".
const SEEDED_ADDRESS = "contact@beaconmfg.example";
// What `transform: domain` leaves behind — `split_part(col, '@', 2)` in sql/mask.ts.
const MASKED_ADDRESS = "beaconmfg.example";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;

beforeAll(async () => {
  db = await setupWebDbWithData("relmask");
  const app = getAppPool();
  const harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
  const cfg = loadConfig(harborDir);

  const grantId = await requestGrant(app, {
    userId: "ana",
    collection: "matters",
    env: "live",
    workspaceId: "default",
    purposeLabel: "test",
    allowedFields: ["id", "matter_number", "client_id", "client"],
  });
  // Approving a live-env grant for oneself is refused (self_approval_denied) — a different
  // persona has to decide it, same as any other live grant.
  const approved = await approveGrant(app, cfg, grantId, "marcus", {
    verbs: ["read"],
    mode: "direct",
  });
  if (!approved.ok) throw new Error(`grant approval failed: ${approved.error}`);
}, 60_000);

afterAll(async () => {
  await db?.end();
});

describe("harbor: matters.client.primary_contact_email stays domain-masked", () => {
  it("masks the seeded address on a live document, and never serializes it raw", async () => {
    const { broker } = getBroker();
    const ctx: BrokerContext = {
      userId: "ana",
      workspaceId: "default",
      env: "live",
      allowedCollections: null,
      via: "test",
    };
    const r = await broker.query(ctx, {
      collection: "matters",
      filters: [{ field: "matter_number", op: "eq", value: "M-2025-9001" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.documents.length).toBe(1);

    const client = (r.documents[0] as { client: { primary_contact_email: unknown } }).client;
    // Positively, not just `not.toBe(SEEDED_ADDRESS)`: a relation that resolved to an empty
    // object would leave this undefined and satisfy the negative assertion vacuously.
    expect(client.primary_contact_email).toBe(MASKED_ADDRESS);

    // The FULL serialized response, not only the extracted field, must never carry the raw
    // seeded address — a masking regression could still leave it reachable through some other
    // path in the same payload.
    expect(JSON.stringify(r)).not.toContain(SEEDED_ADDRESS);
  });
});
