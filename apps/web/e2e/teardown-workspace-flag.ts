import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Undoes the one write scripts/e2e-setup.ts makes outside the database: a local override
// turning workspaces.enabled on for examples/harbor, so apps/web/e2e/workspace-switch.spec.ts has
// a mounted switcher to exercise. *.local.yml is gitignored, so leaving it would not show up in
// git — but apps/web/test/helpers/web-db.ts and scripts/dev-bootstrap.ts load that exact
// directory's config too, and a stray `enabled: true` would silently change what every other
// suite's "flag off" assumption actually is on this machine. Runs regardless of test outcome —
// Playwright calls globalTeardown even after a failed run, as long as globalSetup did not throw.
export default function globalTeardown() {
  const harborDir = resolve(fileURLToPath(import.meta.url), "../../../../examples/harbor");
  rmSync(resolve(harborDir, "warehousd.local.yml"), { force: true });
}
