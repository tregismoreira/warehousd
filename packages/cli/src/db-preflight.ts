// Proving the database we are about to hand the server is one we can actually open.
//
// The server's own entrypoint waits for Postgres and gives up after 60s, and `start` then waits
// 180s for a health endpoint that is never going to answer. Both of those are timeouts, and a
// timeout is the wrong shape for the failure that actually happens here: a password Postgres has
// already refused, deterministically, on the first attempt. This module is what turns that into an
// immediate refusal naming the recovery.

import { Pool } from "pg";

/** Postgres SQLSTATE `invalid_password`. The database has answered, and the answer is no. */
const INVALID_PASSWORD = "28P01";

export function isInvalidPassword(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === INVALID_PASSWORD
  );
}

/**
 * The one failure `start` could previously only report as a timeout.
 *
 * Postgres honours `POSTGRES_PASSWORD` when it initialises an empty data directory and ignores it
 * on every subsequent boot. The volume outlives the state file and is named globally
 * (`wh_<project>_pgdata`), while `.warehousd/state.json` is per-directory and gitignored — so the
 * two come apart whenever the file is deleted, or the same project is started from a second
 * checkout. The credential in state is then simply wrong for this cluster, and no amount of
 * waiting changes that.
 */
export function staleVolumeError(o: { volume: string; stateFile: string }): Error {
  return new Error(
    `The database in volume ${o.volume} refused the password in ${o.stateFile}.\n\n` +
      `Postgres sets its password only when it first initialises a volume and ignores it ` +
      `afterwards, so a volume that outlived its state file keeps the password it was created ` +
      `with. That happens when ${o.stateFile} is deleted, or when this project is started from a ` +
      `second checkout — the volume name is shared between them, the state file is not.\n\n` +
      `To start over from an empty database:\n\n` +
      `    warehousd stop --destroy --yes\n\n` +
      `That deletes the volume and everything in it, and is irreversible. To keep the data ` +
      `instead, restore the ${o.stateFile} that matches this volume.`,
  );
}

export type WaitForDatabaseOptions = {
  volume: string;
  stateFile: string;
  timeoutMs: number;
  intervalMs?: number;
  /**
   * One attempt at opening the database. Required rather than defaulted: the only sensible default
   * would need a URL this type does not carry, and a default that connects to nothing is a worse
   * answer than asking. `waitForDatabaseAt` is the form that takes a URL.
   */
  connect: () => Promise<void>;
};

const DEFAULT_INTERVAL_MS = 500;

function connectOnce(url: string): () => Promise<void> {
  return async () => {
    // One connection, not a pool that retries behind our back: the point is to see this attempt's
    // error. `end()` in a finally so a refused attempt does not leak the client — the same leak
    // that made the entrypoint's 60s wait cost up to 120 dangling pools.
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
    try {
      await pool.query("select 1");
    } finally {
      await pool.end();
    }
  };
}

/**
 * Wait until the database opens, or refuse.
 *
 * "Not ready yet" and "wrong password" are different answers and are treated differently: the
 * first is retried until the deadline, the second ends the wait at once. Anything else is retried
 * too — a driver error early in a container's life is usually the socket not being up.
 */
export async function waitForDatabase(o: WaitForDatabaseOptions): Promise<void> {
  const connect = o.connect;
  const interval = o.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + o.timeoutMs;
  let last: unknown;

  for (;;) {
    try {
      await connect();
      return;
    } catch (err: unknown) {
      if (isInvalidPassword(err)) throw staleVolumeError(o);
      last = err;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, interval));
  }

  const detail = last instanceof Error ? last.message : String(last);
  throw new Error(
    `The database in volume ${o.volume} did not accept a connection within ` +
      `${Math.round(o.timeoutMs / 1000)}s: ${detail}`,
  );
}

/** The form `start` calls: a real connection against `url`, everything else as above. */
export function waitForDatabaseAt(
  url: string,
  o: Omit<WaitForDatabaseOptions, "connect">,
): Promise<void> {
  return waitForDatabase({ ...o, connect: connectOnce(url) });
}
