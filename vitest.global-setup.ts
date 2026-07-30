import { dropStaleClones, ensureTemplate } from "./packages/broker/test/helpers/templates";
import { bootstrapBrokerDb, ensureRoles } from "./packages/broker/test/helpers/db";
import { bootstrapWebDb, applyHarborData } from "./apps/web/test/helpers/web-db";

// Every test database used to be bootstrapped from scratch — schemas, roles, the app schema,
// a `@better-auth/cli migrate` subprocess and three persona signups, 40 times over, plus 90
// lighter broker provisions. That work is identical every time, so it happens once here and
// each test copies the result with `create database ... template`, which is a file copy.
//
// The templates are deliberately left behind between runs; the fingerprint in
// packages/broker/test/helpers/templates.ts is what decides when they are stale. Set
// WAREHOUSD_TEST_REBUILD_TEMPLATES=1 to force a rebuild.
export async function setup() {
  const t0 = Date.now();

  // Collect the previous run's corpses before doing anything else. `teardown()` below handles the
  // ordinary case, but it cannot run if the run was killed — Ctrl-C, an OOM, a killed worker — so
  // this is the only place those get reclaimed. Between them the leak is self-healing rather than
  // dependent on anyone running a cleanup command.
  const swept = await dropStaleClones();
  if (swept)
    console.log(`[templates] swept ${swept} leftover test database(s) from a previous run`);

  const broker = await ensureTemplate("broker", bootstrapBrokerDb);
  await ensureRoles();
  const web = await ensureTemplate("web", bootstrapWebDb);
  // Layered on the web template rather than rebuilt: applyHarborData must not re-run the web
  // bootstrap, because lib/auth binds APP_DATABASE_URL at module load.
  const webData = await ensureTemplate("web_data", applyHarborData, { from: "web" });

  if (broker || web || webData) {
    console.log(`[templates] rebuilt in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

// There was no teardown at all before this, which is why the leak grew monotonically: each suite's
// `provision()` returns an `end()` that drops its database, and `end()` is called from `afterAll`,
// so it runs only on the happy path. A hook that throws, a timeout, or an interrupted run left the
// database behind permanently. `cloneTemplate`'s pre-create `drop database if exists` is not a
// teardown — it only reclaims a name when the same label and pid happen to recur.
//
// The templates are kept: they are the cache this whole file exists to maintain.
export async function teardown() {
  const dropped = await dropStaleClones();
  if (dropped) console.log(`[templates] dropped ${dropped} test database(s)`);
}
