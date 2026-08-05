import { Pool } from "pg";

/**
 * Poll Postgres until it answers, and hand back the pool that answered.
 *
 * Every attempt used to construct a `new Pool` and end it only on success, so a 60s wait at 500ms
 * intervals left up to 120 of them dangling — each holding whatever socket its connect attempt was
 * still in the middle of. Against a local container that answers on the first try this cost
 * nothing, which is why it survived; against a Neon endpoint resuming from suspend, or a hosted
 * url with one wrong character, the whole wait is failed attempts.
 */
export async function waitForPostgres(appUrl: string, timeoutMs: number): Promise<Pool> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const db = new Pool({ connectionString: appUrl });
    try {
      await db.query("select 1");
      // The pool that just proved the connection works, rather than a fresh one: a second pool
      // here would only repeat the handshake, and this one is already warm.
      return db;
    } catch {
      // end() on a pool whose only client failed can reject too; there is nothing left to clean
      // up if it does, and throwing from here would lose the retry.
      await db.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timeout waiting for Postgres after ${timeoutMs}ms`);
}
