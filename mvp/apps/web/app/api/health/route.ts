// Liveness probe for `warehousd start`/`status`. Reached only after the container entrypoint's
// bootstrap has completed, because the entrypoint runs to completion before `next start` is exec'd.
export async function GET() {
  return Response.json({ ok: true });
}
