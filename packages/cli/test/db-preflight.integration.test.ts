import { describe, it, expect, afterAll } from "vitest";
import { provision, type Provisioned } from "../../broker/test/helpers/db";
import { isInvalidPassword, waitForDatabaseAt } from "../src/db-preflight";

/**
 * The unit tests next door assert on a synthetic `{ code: "28P01" }`, which proves the branching
 * and nothing about Postgres. The whole fix rests on a real server actually reporting that code for
 * a wrong password rather than, say, a generic connection error — so this file asks a real one.
 *
 * It also covers the two functions that open a socket, which no mocked test can reach.
 */

let p: Provisioned;
afterAll(async () => {
  await p?.end();
});

describe("waitForDatabaseAt against a real Postgres", () => {
  const opts = { volume: "wh_test_pgdata", stateFile: ".warehousd/state.json" };

  it("returns once the database accepts the credentials it was given", async () => {
    p = await provision("cli-dbpre");
    await expect(
      waitForDatabaseAt(p.urls.admin, { ...opts, timeoutMs: 10_000, intervalMs: 100 }),
    ).resolves.toBeUndefined();
  });

  // The load-bearing assertion: a real rejection has to be distinguishable from "not up yet", or
  // the stale-volume case goes back to being waited out rather than reported.
  it("reports a wrong password as a stale volume, and does so promptly", async () => {
    const wrong = p.urls.admin.replace(/:\/\/([^:]+):[^@]+@/, "://$1:definitely-not-the-password@");
    expect(wrong).not.toBe(p.urls.admin);

    const started = Date.now();
    await expect(
      // A timeout long enough that waiting it out would be obvious in the elapsed time below.
      waitForDatabaseAt(wrong, { ...opts, timeoutMs: 30_000, intervalMs: 100 }),
    ).rejects.toThrow(/stop --destroy/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a real driver rejection carries the code the classifier keys on", async () => {
    const wrong = p.urls.admin.replace(/:\/\/([^:]+):[^@]+@/, "://$1:definitely-not-the-password@");
    let caught: unknown;
    await waitForDatabaseAt(wrong, { ...opts, timeoutMs: 1, intervalMs: 1 }).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(Error);

    // And directly: the driver's own error, unwrapped by anything of ours.
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: wrong, max: 1, connectionTimeoutMillis: 5_000 });
    let raw: unknown;
    try {
      await pool.query("select 1");
    } catch (err: unknown) {
      raw = err;
    } finally {
      await pool.end();
    }
    expect(isInvalidPassword(raw)).toBe(true);
  });

  // Nothing here should be mistaken for a stale volume: a port with no server is the ordinary
  // "still starting" case, and treating it as a credential problem would send people to
  // `--destroy` over a container that simply had not opened its socket yet.
  it("a port with nothing behind it times out rather than blaming the credentials", async () => {
    await expect(
      waitForDatabaseAt("postgres://warehousd:pw@127.0.0.1:1/warehousd", {
        ...opts,
        timeoutMs: 300,
        intervalMs: 50,
      }),
    ).rejects.toThrow(/did not accept a connection/);
  });
});
