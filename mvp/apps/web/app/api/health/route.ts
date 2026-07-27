import { getAppPool } from "../../lib/broker";

// Liveness probe for `warehousd start`/`status`. Reached only after the container entrypoint's
// bootstrap has completed, because the entrypoint runs to completion before `next start` is exec'd.
// Checks both process liveness and database connectivity.
export async function GET() {
  // getAppPool() is inside the try on purpose: the first call builds the pools and parses
  // the config, and a failure there is exactly the "process is up, Postgres is gone" case
  // this probe exists to catch — it must answer 503, not throw an unhandled 500 with a stack.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Query with 5-second timeout. If DB is down or unresponsive, return 503.
    await Promise.race([
      getAppPool().query("select 1"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DB timeout")), 5000);
      }),
    ]);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  } finally {
    // Promise.race does not cancel the loser. `warehousd status` (packages/cli/src/status.ts)
    // and Fly poll this endpoint, so an uncleared timer per request pins the event loop for
    // 5s each time.
    clearTimeout(timer);
  }
}
