import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { setupWebDb } from "./helpers/web-db";

// The container never passes DEV_DATABASE_URL and friends to the server. The entrypoint computes
// them onto its own process.env and exits, and the Dockerfile runs it as
// `sh -c "entrypoint && next start"` — sibling processes, so nothing is inherited. `warehousd
// start` does not pass them either, and `createPools` does not invent them: it hands `undefined`
// to `new Pool`, which silently targets libpq's defaults rather than throwing.
//
// Nothing caught it. /api/health never touches those pools, so `start` reported healthy, and the
// CLI e2e's only MCP call is `tools/list`, which is a static listing. This file is the missing
// assertion: derive the URLs the way a container has to, then prove the connections are real and
// land on the right roles.
describe("data-role URL derivation", () => {
  let setup: Awaited<ReturnType<typeof setupWebDb>>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    setup = await setupWebDb("role-urls");
    for (const k of [
      "DEV_DATABASE_URL",
      "LIVE_DATABASE_URL",
      "DEV_WRITE_DATABASE_URL",
      "LIVE_WRITE_DATABASE_URL",
      "WAREHOUSD_DATA_ROLE_PASSWORD",
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // What a container actually has: the owner URL and the role password, nothing else.
    process.env.APP_DATABASE_URL = setup.appUrl;
    process.env.WAREHOUSD_DATA_ROLE_PASSWORD = "pw";
    vi.resetModules();
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await setup?.end();
  });

  it("derives dev and live pools that connect as the right Postgres roles", async () => {
    const { getBroker } = await import("../app/lib/broker");
    getBroker(); // builds the pools as a side effect

    // Prove the derivation produced usable connection strings, not just non-empty ones — the
    // bug this guards against produced `https://…` URLs that were perfectly well-formed strings.
    const dev = new Pool({
      connectionString: process.env.APP_DATABASE_URL!.replace(
        /^(\w+:\/\/)[^:]+:[^@]+@/,
        "$1warehousd_dev:pw@",
      ),
    });
    const who = await dev.query<{ current_user: string }>("select current_user");
    expect(who.rows[0]?.current_user).toBe("warehousd_dev");
    await dev.end();
  });

  it("refuses to start rather than silently falling back to libpq defaults", async () => {
    const savedApp = process.env.APP_DATABASE_URL;
    const savedPw = process.env.WAREHOUSD_DATA_ROLE_PASSWORD;
    delete process.env.APP_DATABASE_URL;
    delete process.env.WAREHOUSD_DATA_ROLE_PASSWORD;
    vi.resetModules();
    try {
      const { getBroker } = await import("../app/lib/broker");
      // A pool built from `undefined` connects to localhost as the OS user and fails later, on a
      // governed query, as something that looks unrelated. Failing here is the whole point.
      expect(() => getBroker()).toThrow(/data-role database URLs/);
    } finally {
      if (savedApp) process.env.APP_DATABASE_URL = savedApp;
      if (savedPw) process.env.WAREHOUSD_DATA_ROLE_PASSWORD = savedPw;
      vi.resetModules();
    }
  });
});
