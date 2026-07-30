import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { provision, type Provisioned } from "./helpers/db";
import { createPools, withOrg } from "../src/db/pools";

// No statement was bounded before this. A single slow scan held a pool connection for as long as
// Postgres would work on it, and a pool has a finite number of them.
let p: Provisioned;
beforeAll(async () => {
  p = await provision("pool-timeouts");
}, 60_000);
afterAll(async () => {
  await p?.end();
});

const urlsOf = (pr: Provisioned) => ({
  app: pr.urls.admin,
  dev: pr.urls.dev,
  live: pr.urls.live,
  imp: pr.urls.imp,
  devWrite: pr.urls.devWrite,
  liveWrite: pr.urls.liveWrite,
});

describe("pool statement bounds", () => {
  it("applies a bound to every pool it creates", async () => {
    const pools = createPools(urlsOf(p));
    try {
      for (const name of ["app", "dev", "live", "imp", "devWrite", "liveWrite"] as const) {
        const pool = pools[name];
        if (!pool) continue;
        const r = await pool.query(`show statement_timeout`);
        // "0" would mean unbounded, which is what this test exists to prevent.
        expect(r.rows[0].statement_timeout, `${name} must be bounded`).not.toBe("0");
      }
    } finally {
      await pools.end();
    }
  });

  it("bounds the idle transaction too, which a statement timeout cannot cover", async () => {
    // withOrg holds a transaction open across arbitrary JavaScript. If that stalls, no statement
    // is running, so statement_timeout never fires while the locks and xmin are still held.
    const pools = createPools(urlsOf(p));
    try {
      const r = await pools.dev.query(`show idle_in_transaction_session_timeout`);
      expect(r.rows[0].idle_in_transaction_session_timeout).not.toBe("0");
    } finally {
      await pools.end();
    }
  });

  it("cancels a statement that overruns the bound, inside withOrg's transaction", async () => {
    process.env.WAREHOUSD_STATEMENT_TIMEOUT_MS = "400";
    const pools = createPools(urlsOf(p));
    try {
      const started = Date.now();
      await expect(
        withOrg(pools.dev, "default", (c) => c.query(`select pg_sleep(10)`)),
      ).rejects.toMatchObject({ code: "57014" }); // query_canceled
      // Proves the bound did the cancelling rather than the query simply finishing.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await pools.end();
      delete process.env.WAREHOUSD_STATEMENT_TIMEOUT_MS;
    }
  }, 30_000);

  it("gives the app and import pools a longer bound than the query pools", async () => {
    // regenerateSynthetic runs on the app pool from an admin route and takes seconds per
    // collection; the import path streams whole files. The query bound would abort both.
    const pools = createPools(urlsOf(p));
    const ms = async (pool: import("pg").Pool) =>
      Number(
        (
          await pool.query(
            `select setting::bigint as v from pg_settings where name='statement_timeout'`,
          )
        ).rows[0].v,
      );
    try {
      const queryBound = await ms(pools.dev);
      expect(await ms(pools.app)).toBeGreaterThan(queryBound);
      if (pools.imp) expect(await ms(pools.imp)).toBeGreaterThan(queryBound);
    } finally {
      await pools.end();
    }
  });

  it("ignores an unparseable override rather than dropping the bound", async () => {
    // The failure mode worth guarding: a typo in a deployment's env silently removing the
    // ceiling it was meant to adjust.
    process.env.WAREHOUSD_STATEMENT_TIMEOUT_MS = "thirty seconds";
    const pools = createPools(urlsOf(p));
    try {
      expect((await pools.dev.query(`show statement_timeout`)).rows[0].statement_timeout).toBe(
        "30s",
      );
    } finally {
      await pools.end();
      delete process.env.WAREHOUSD_STATEMENT_TIMEOUT_MS;
    }
  });
});
