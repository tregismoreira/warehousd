// A fixed-window counter for the credential endpoints.
//
// Better Auth rate-limits its own `/api/auth/*` routes (enabled by default in production, 100
// requests per 10s per IP). `/v1/token` is ours and had nothing, which matters more than it looks:
// every attempt runs an scrypt derivation in verifyClientSecret, so an unauthenticated caller can
// spend server CPU at will. Guessing a key is not the threat — they are 96 bits of CSPRNG behind a
// checksum — the cost of being asked to check is.
//
// Deliberately in-memory and per-process. It is a cost cap, not a distributed quota: behind
// several replicas each holds its own window, and a restart clears them. Anything stronger belongs
// at the ingress, and SECURITY.md already puts TLS and the proxy in the operator's hands.
type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

// Bounds the map against a caller who rotates the key on every request (a new client_id each
// time), which would otherwise be a memory leak dressed as a rate limiter. Sweeping only on
// growth keeps the common path a single Map lookup.
const MAX_TRACKED = 10_000;

function sweep(now: number): void {
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
  // Still oversized after dropping everything expired: the live set itself is the problem, so
  // drop it wholesale rather than grow without bound. Callers get one free window; the cost cap
  // re-establishes itself immediately.
  if (windows.size > MAX_TRACKED) windows.clear();
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function rateLimit(
  key: string, opts: { max: number; windowMs: number }, now = Date.now(),
): RateLimitResult {
  if (windows.size > MAX_TRACKED) sweep(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true };
  }
  if (existing.count >= opts.max) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  existing.count += 1;
  return { ok: true };
}

// Test seam. Windows are process-global, so a suite asserting the limit would otherwise leak its
// counters into whatever ran next in the same worker.
export function resetRateLimits(): void {
  windows.clear();
}
