import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
import type { Pools } from "../src/db/pools";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { captureLogs } from "./helpers/log-capture";

// Planted in a driver error's DETAIL field, which is where Postgres reports row values.
const AUDIT_LEAK_CANARY = "CANARY_AUDIT_DETAIL_LEAK_4c1d";

// The audit write is the one thing the broker treats as non-negotiable, and until Phase 4 it was
// also the one thing nothing guarded: ~25 `await writeAudit(…)` calls, none of them wrapped. A
// failing `app.audit_events` insert threw out of the verb — including out of `query`'s own catch
// block, whose refusal path is itself an audit write — so the caller got an unhandled rejection
// and no audit row at all.
//
// These tests hold the replacement to three properties: the failure is a *controlled* refusal,
// nothing is fabricated to stand in for the missing id, and a data write whose decision could not
// be recorded does not commit.

let p: Provisioned, admin: Pool, pools: Pools;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    people: {
      description: "People",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

const ctx: BrokerContext = {
  userId: "auditfail_user",
  env: "dev",
  orgId: "default",
  allowedCollections: null,
  via: "session",
};

// Everything the broker asks the app pool for keeps working except the audit insert. Failing the
// whole pool would prove much less: the grant lookup would fail first and the verb would never
// reach the decision this is about.
function withFailingAudit(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop !== "query") return Reflect.get(target, prop, receiver);
      return (text: unknown, ...rest: unknown[]) => {
        if (typeof text === "string" && text.includes("app.audit_events"))
          return Promise.reject(new Error("simulated audit outage"));
        return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
      };
    },
  });
}

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("audit-failure");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({
    app: p.urls.admin,
    dev: p.urls.dev,
    live: p.urls.live,
    devWrite: p.urls.devWrite,
    liveWrite: p.urls.liveWrite,
  });

  const grantId = await requestGrant(pools.app, {
    userId: ctx.userId,
    collection: "people",
    env: "dev",
    orgId: "default",
    purposeLabel: "test",
    allowedFields: ["id", "email"],
  });
  await approveGrant(pools.app, cfg, grantId, "admin", { verbs: ["read", "create"] });

  broker = makeBroker({ ...pools, app: withFailingAudit(pools.app) }, cfg);
}, 60_000);

afterAll(async () => {
  await admin?.end();
  await pools?.end();
  await p?.end();
});

describe("an audit write that fails", () => {
  it("turns an otherwise-successful query into a controlled internal_error, not a throw", async () => {
    const r = await broker.query(ctx, { collection: "people", fields: ["email"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("internal_error");
      // Not a fabricated id: there is no audit row, and the result says so.
      expect(r.auditId).toBeNull();
    }
  });

  it("leaves a refusal's own reason intact — there is nothing to withhold", async () => {
    const r = await broker.query({ ...ctx, userId: "no_grant_at_all" }, { collection: "people" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no_grant");
      expect(r.auditId).toBeNull();
    }
  });

  it("refuses discovery rather than listing collections unrecorded", async () => {
    const r = await broker.listCollections(ctx);
    expect(Array.isArray(r)).toBe(false);
    if (!Array.isArray(r)) {
      expect(r.reason).toBe("internal_error");
      expect(r.auditId).toBeNull();
    }
  });

  it("rolls the write back: a mutation whose decision was not recorded did not happen", async () => {
    const r = await broker.mutate(ctx, {
      collection: "people",
      op: "create",
      values: { email: "rolled-back@example.com" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("internal_error");
      expect(r.auditId).toBeNull();
    }

    // The insert ran inside withOrg before the audit write; returning the refusal from inside the
    // transaction would have committed it. assertRecorded throws instead, so nothing is there.
    const rows = await admin.query(`select 1 from data_synth.people where email = $1`, [
      "rolled-back@example.com",
    ]);
    expect(rows.rowCount).toBe(0);
    // The change feed is written in the same transaction, so it must be empty too.
    const feed = await admin.query(
      `select 1 from app.change_log where collection = 'people' and env = 'dev'`,
    );
    expect(feed.rowCount).toBe(0);
  });

  it("does not leave an unhandled rejection behind", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await broker.query(ctx, { collection: "people", fields: ["email"] });
      await broker.mutate(ctx, {
        collection: "people",
        op: "create",
        values: { email: "u@example.com" },
      });
      await broker.changes(ctx, {});
      await broker.listRevisions(ctx, {
        collection: "people",
        id: "00000000-0000-0000-0000-000000000000",
      });
      await broker.listProposals(ctx, {});
      await broker.getProposal(ctx, "00000000-0000-0000-0000-000000000000");
      await broker.approveProposal(ctx, "00000000-0000-0000-0000-000000000000");
      await broker.rejectProposal(ctx, "00000000-0000-0000-0000-000000000000");
      await broker.describeCollection(ctx, "people");
      await broker.searchDocuments(ctx, { collection: "people", q: "x" });
      await broker.getDocument(ctx, {
        collection: "people",
        id: "00000000-0000-0000-0000-000000000000",
      });
      // Give the loop a turn so a rejection settled after the await would still be seen.
      await new Promise((res) => setImmediate(res));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  // The audit-failure log is the only remaining trace of an unrecorded decision, so it carries the
  // most context of any line the broker writes — and a pg error brings row values with it.
  // Postgres puts them in DETAIL ("Key (email)=(a@b.com) already exists"), so logging the driver
  // error whole is a way for a denied value to reach a log line: the half of invariant 4 that is
  // easiest to forget, because the response was correctly clean the whole time.
  it("does not put a driver error's DETAIL values into the failure log", async () => {
    const leaky = new Proxy(pools.app, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (text: unknown, ...rest: unknown[]) => {
          if (typeof text === "string" && text.includes("app.audit_events")) {
            // Shaped like node-postgres' error: enumerable fields alongside the message.
            const err = Object.assign(new Error("duplicate key value violates unique constraint"), {
              code: "23505",
              detail: `Key (home_address)=(${AUDIT_LEAK_CANARY}) already exists.`,
              table: "audit_events",
            });
            return Promise.reject(err);
          }
          return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
        };
      },
    });
    const leakyBroker = makeBroker({ ...pools, app: leaky }, cfg);

    const capture = captureLogs();
    let result: unknown;
    try {
      result = await leakyBroker.query(ctx, { collection: "people", fields: ["email"] });
    } finally {
      capture.restore();
    }

    // Still a controlled refusal — the redaction must not have changed the outcome.
    expect((result as { ok: boolean }).ok).toBe(false);

    // The log fired at all, so an empty capture cannot be why this passes.
    expect(capture.text()).toContain("AUDIT WRITE FAILED");
    expect(capture.text()).toContain("[redacted]");
    expect(capture.text().includes(AUDIT_LEAK_CANARY), "driver DETAIL value reached the log").toBe(
      false,
    );
  });
});
