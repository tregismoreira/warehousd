import { describe, it, expect } from "vitest";
import { Pool } from "pg";
import { provision } from "./db";
import {
  ADMIN,
  SUFFIX,
  runDbName,
  cloneLikePattern,
  dropStaleClones,
  templateName,
} from "./templates";

// The two properties that actually regressed, per the plan's 5.4.1. Both are cheap.
//
// What leaked: `provision()` hands back an `end()` that drops its database, and `end()` is called
// from each suite's `afterAll` — so it ran only on the happy path. Nothing swept the rest, and the
// per-run clone name carried no checkout suffix, so no sweep *could* be written that would not also
// destroy a sibling checkout's in-flight databases.

async function exists(name: string): Promise<boolean> {
  const admin = new Pool({ connectionString: ADMIN, max: 1 });
  try {
    const r = await admin.query(`select 1 from pg_database where datname = $1`, [name]);
    return (r.rowCount ?? 0) > 0;
  } finally {
    await admin.end();
  }
}

describe("test database lifecycle", () => {
  it("end() is idempotent", async () => {
    const p = await provision("leak-idempotent");
    expect(await exists(p.dbName)).toBe(true);

    await p.end();
    expect(await exists(p.dbName)).toBe(false);
    // The second call is the one that matters: `afterAll` can run after a suite already cleaned up,
    // and a throw here would be reported as a suite failure with no failing assertion behind it.
    await expect(p.end()).resolves.toBeUndefined();
    expect(await exists(p.dbName)).toBe(false);
  });

  it("the sweep collects a database whose owner never cleaned up, and spares the templates", async () => {
    // Stands in for a suite whose `beforeAll` threw after `provision` returned: the database exists
    // and no `end()` will ever be called on it. The pid slot is deliberately not a number — every
    // real pid is one, and picking a specific "dead" pid is not something a test can guarantee.
    const orphan = `wh_leaked_orphan_${SUFFIX}`;
    const admin = new Pool({ connectionString: ADMIN, max: 1 });
    await admin.query(`drop database if exists ${orphan} with (force)`);
    await admin.query(`create database ${orphan}`);
    await admin.end();
    expect(await exists(orphan)).toBe(true);

    await dropStaleClones();

    expect(await exists(orphan)).toBe(false);
    // The templates are the cache the whole harness is built on; a sweep that took them would turn
    // every later run into a full rebuild.
    expect(await exists(templateName("broker"))).toBe(true);
  });

  it("spares a clone whose owning process is still alive", async () => {
    // This test's own process is alive, so its own clone must survive a sweep — the guard that
    // stops a second concurrent vitest run from destroying the first one's databases.
    const p = await provision("leak-alive");
    try {
      await dropStaleClones();
      expect(await exists(p.dbName)).toBe(true);
    } finally {
      await p.end();
    }
  });

  it("refuses a database name Postgres would silently truncate", () => {
    // Two names differing only past byte 63 become the same database, so a suite would run against
    // another suite's data rather than fail.
    expect(() => runDbName("x".repeat(64))).toThrow(/truncates at 63/);
  });

  it("scopes the sweep pattern to this checkout, suffix last", () => {
    // The suffix is the whole reason a sweep is safe to write at all: sibling checkouts share this
    // cluster. See the SUFFIX comment in templates.ts.
    expect(cloneLikePattern()).toContain(SUFFIX);
    // Ends with the suffix, not merely contains it. scripts/agent/cleanup.sh sweeps
    // `datname like '%\_<SUFFIX>'` and cannot import this module to find out; moving the suffix off
    // the end would leave that script matching nothing, which is indistinguishable from a clean
    // cluster. This assertion is the only thing holding the two in agreement.
    expect(runDbName("somelabel")).toMatch(new RegExp(`_${SUFFIX}$`));
  });
});
