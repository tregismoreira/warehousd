import { getAppPool } from "../../lib/broker";

// Liveness probe for `warehousd start`/`status`. Reached only after the container entrypoint's
// bootstrap has completed, because the entrypoint runs to completion before `next start` is exec'd.
// Checks both process liveness and database connectivity.
export async function GET() {
  const app = getAppPool();
  try {
    // Query with 5-second timeout. If DB is down or unresponsive, return 503.
    const result = await Promise.race([
      app.query("select 1"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DB timeout")), 5000)),
    ]);
    if (!result) return Response.json({ ok: false }, { status: 503 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
