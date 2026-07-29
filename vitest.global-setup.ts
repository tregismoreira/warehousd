import { ensureTemplate } from "./packages/broker/test/helpers/templates";
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
