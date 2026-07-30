import type { FullConfig } from "@playwright/test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `next dev` compiles a route the first time something asks for it, and this suite runs against
// `next dev` on purpose (see playwright.config.ts — a production build turns on better-auth's rate
// limiter). So the first test to touch a given route pays for its webpack compile *inside* an
// `expect` timeout, and on a machine with several checkouts competing for CPU that compile can
// outrun the 15s assertion budget. That is what made `manager.spec.ts`'s "Access requested" toast
// fail once and then pass on its own: not a race in the app, a cold compile under an assertion.
//
// Raising the assertion timeout would hide it; a local retry would hide real flakes with it. So
// pay the compile up front instead, before any assertion is watching. Playwright runs globalSetup
// after the webServer's `url` responds, so the server is live by the time this starts.
//
// Total work is unchanged — every one of these compiles happens during the run anyway. It only
// moves out from under the clock.
const APP_DIR = resolve(fileURLToPath(import.meta.url), "../../app");

function* entries(dir: string): Generator<{ file: string; dir: string }> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* entries(p);
    else yield { file: e.name, dir };
  }
}

// app/manager/review/page.tsx -> /manager/review, app/v1/collections/[c]/route.ts ->
// /v1/collections/warmup. A dynamic segment needs *some* value to route; the value is irrelevant
// because no handler runs (see `method` below), only the module gets built.
function urlPath(dir: string): string {
  const segments = dir
    .slice(APP_DIR.length)
    .split("/")
    .filter(Boolean)
    // Route groups and parallel routes are organisational, not part of the URL.
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"))
    .map((s) => (s.startsWith("[") ? "warmup" : s));
  return "/" + segments.join("/");
}

async function warm(url: string, method: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    // 401/403/405/redirects all mean the module was found and built. A 404 means it was not — the
    // path this file derived does not exist, so nothing was warmed and the mapping needs fixing.
    return r.status === 404 ? `${method} ${url}: 404, derived path does not resolve` : null;
  } catch (e) {
    // Reported, never thrown. Warming is an optimisation, so a miss must not fail the run — but a
    // silent miss is worse than none at all: a typo in a path, or a method the fetch stack refuses
    // to send, would turn this whole file into a no-op that still prints a reassuring line.
    return `${method} ${url}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;

  const targets: { url: string; method: string }[] = [];
  for (const { file, dir } of entries(APP_DIR)) {
    // GET on a page is a read; the server components either render or redirect to /login.
    if (file === "page.tsx") targets.push({ url: baseURL + urlPath(dir), method: "GET" });
    // A route handler is a different matter: GET on `/api/admin/regen-synth` would be a real
    // request with real effects, and Next synthesises HEAD from GET, so HEAD is no safer. A method
    // no route exports gets the module built and then a 405 from the framework, without ever
    // reaching our code. That is exactly the half we want.
    if (file === "route.ts") targets.push({ url: baseURL + urlPath(dir), method: "WARMUP" });
  }

  // Four at a time. `next dev` serialises the compiles themselves, so more concurrency buys
  // nothing and this machine may well be running another workspace's suite next to this one.
  const started = Date.now();
  const queue = targets.slice();
  const misses: string[] = [];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let t = queue.pop(); t; t = queue.pop()) {
        const miss = await warm(t.url, t.method);
        if (miss) misses.push(miss);
      }
    }),
  );
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(`warmed ${targets.length - misses.length}/${targets.length} routes in ${elapsed}s`);
  for (const m of misses) console.log(`  warm-up miss: ${m}`);
}
