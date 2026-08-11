import { describe, it, expect } from "vitest";
import { isInvalidPassword, staleVolumeError, waitForDatabase } from "../src/db-preflight";

// The bug these cover.
//
// Postgres reads POSTGRES_PASSWORD only when it initialises an empty data directory. On a volume
// that already holds a cluster the variable is ignored entirely, so a `.warehousd/state.json` that
// no longer matches — regenerated because the file was deleted, or because the project is being
// started from a second checkout while the volume name is global — hands the server a password the
// database has never had.
//
// What that looked like: `start` sat on the health check for its full 180 seconds and then blamed
// "a SQL error applying the config or an unreachable database", while the database had been
// answering "password authentication failed for user warehousd" from the first second.

const pgError = (code: string): Error => Object.assign(new Error("nope"), { code });

describe("isInvalidPassword", () => {
  it("recognises the Postgres code for a rejected password", () => {
    expect(isInvalidPassword(pgError("28P01"))).toBe(true);
  });

  // 28000 is the neighbouring class (invalid_authorization_specification) — a missing role rather
  // than a wrong password, which is not a stale volume and must not be reported as one.
  it("does not treat a connection refusal or a missing role as one", () => {
    expect(isInvalidPassword(pgError("ECONNREFUSED"))).toBe(false);
    expect(isInvalidPassword(pgError("28000"))).toBe(false);
    expect(isInvalidPassword(new Error("boom"))).toBe(false);
    expect(isInvalidPassword(null)).toBe(false);
  });
});

describe("staleVolumeError", () => {
  const err = staleVolumeError({ volume: "wh_harbor_pgdata", stateFile: ".warehousd/state.json" });

  it("names the volume and the state file, which are the two halves that disagree", () => {
    expect(err.message).toContain("wh_harbor_pgdata");
    expect(err.message).toContain(".warehousd/state.json");
  });

  // The whole point: the previous message sent people looking for a SQL error in their config.
  it("gives the command that actually recovers it", () => {
    expect(err.message).toContain("warehousd stop --destroy");
  });

  it("says the data is lost, because --destroy is irreversible", () => {
    expect(err.message).toMatch(/irreversible|deletes|lost/i);
  });
});

describe("waitForDatabase", () => {
  const opts = { volume: "wh_harbor_pgdata", stateFile: ".warehousd/state.json" };

  it("returns once a connection succeeds", async () => {
    let calls = 0;
    await expect(
      waitForDatabase({
        ...opts,
        timeoutMs: 1000,
        intervalMs: 1,
        connect: () => {
          calls += 1;
          return calls < 3 ? Promise.reject(pgError("ECONNREFUSED")) : Promise.resolve();
        },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  // The reason this function exists rather than a plain retry loop: a wrong password is not a
  // "not ready yet", and waiting out the timeout on one turns a deterministic answer into a hang.
  it("fails immediately on a rejected password rather than retrying to the timeout", async () => {
    let calls = 0;
    await expect(
      waitForDatabase({
        ...opts,
        timeoutMs: 60_000,
        intervalMs: 1,
        connect: () => {
          calls += 1;
          return Promise.reject(pgError("28P01"));
        },
      }),
    ).rejects.toThrow(/stop --destroy/);
    expect(calls).toBe(1);
  });

  it("gives up with the last driver error when the database never answers", async () => {
    await expect(
      waitForDatabase({
        ...opts,
        timeoutMs: 20,
        intervalMs: 1,
        connect: () => Promise.reject(pgError("ECONNREFUSED")),
      }),
    ).rejects.toThrow(/did not accept a connection/);
  });
});
