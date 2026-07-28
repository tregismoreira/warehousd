import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker, type Pools } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";

let p: Provisioned, app: Pool;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    data: {
      description: "Data",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        value: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

beforeAll(async () => {
  p = await provision("mutate-env-isolation");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
}, 60_000);

afterAll(async () => { await app.end(); await p.end(); });

describe("broker.mutate env isolation", () => {
  it("env scope: dev context reaches devWrite pool, not liveWrite", async () => {
    const pools = createPools({
      app: p.urls.admin,
      dev: p.urls.dev,
      live: p.urls.live,
      devWrite: p.urls.devWrite,
      liveWrite: p.urls.liveWrite,
    });

    const broker = makeBroker(pools, cfg);

    const grantId = await requestGrant(app, {
      userId: "env_user", collection: "data", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "value"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = { userId: "env_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "data", op: "create", values: { value: "dev_value" } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Data should exist in data_synth (dev), not data_live
      const inDev = await app.query(
        `select value from data_synth.data where id = $1`, [result.documentId]);
      expect(inDev.rows.length).toBe(1);
      expect(inDev.rows[0].value).toBe("dev_value");
    }

    await pools.end();
  });

  it("live context reaches liveWrite pool, not devWrite", async () => {
    const pools = createPools({
      app: p.urls.admin,
      dev: p.urls.dev,
      live: p.urls.live,
      devWrite: p.urls.devWrite,
      liveWrite: p.urls.liveWrite,
    });

    const broker = makeBroker(pools, cfg);

    const grantId = await requestGrant(app, {
      userId: "live_user", collection: "data", env: "live", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "value"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = { userId: "live_user", env: "live", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "data", op: "create", values: { value: "live_value" } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Data should exist in data_live, not data_synth
      const inLive = await app.query(
        `select value from data_live.data where id = $1`, [result.documentId]);
      expect(inLive.rows.length).toBe(1);
      expect(inLive.rows[0].value).toBe("live_value");
    }

    await pools.end();
  });

  it("no write pool configured: mutate returns not_writable", async () => {
    const pools = createPools({
      app: p.urls.admin,
      dev: p.urls.dev,
      live: p.urls.live,
      // No devWrite or liveWrite
    });

    const broker = makeBroker(pools, cfg);

    const grantId = await requestGrant(app, {
      userId: "nopool_user", collection: "data", env: "dev", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "value"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = { userId: "nopool_user", env: "dev", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "data", op: "create", values: { value: "x" } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_writable");
    }

    await pools.end();
  });

  it("live env cannot reach dev pool via mutation", async () => {
    const pools = createPools({
      app: p.urls.admin,
      dev: p.urls.dev,
      live: p.urls.live,
      devWrite: p.urls.devWrite,
      liveWrite: p.urls.liveWrite,
    });

    const broker = makeBroker(pools, cfg);

    const grantId = await requestGrant(app, {
      userId: "isolation_user", collection: "data", env: "live", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "value"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read", "create"] });

    const ctx: BrokerContext = { userId: "isolation_user", env: "live", orgId: "default" };
    const result = await broker.mutate(ctx, { collection: "data", op: "create", values: { value: "should_be_live" } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Data should be in data_live
      const inLive = await app.query(`select 1 from data_live.data where id = $1`, [result.documentId]);
      expect(inLive.rows.length).toBe(1);

      // Data should NOT be in data_synth
      const inDev = await app.query(`select 1 from data_synth.data where id = $1`, [result.documentId]);
      expect(inDev.rows.length).toBe(0);
    }

    await pools.end();
  });
});
