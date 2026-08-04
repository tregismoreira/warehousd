// Typecheck every TypeScript file in the repo, in one command.
//
// Not `tsc -b`: build mode requires every project to be `composite`, and composite forbids
// `noEmit` (TS5069). Three of these four projects exist *only* to be checked — the broker emits
// from its own tsconfig.json, the CLI is bundled by tsup, and apps/web is built by Next — so there
// is nothing for them to emit, and apps/web additionally cannot turn declarations on at all
// (Better Auth's inferred types are not nameable; see the comment in apps/web/tsconfig.json).
// Separate `tsc -p` runs are what that leaves.
//
// Each project is a superset of what it replaces, so nothing is checked twice unnecessarily:
// tsconfig.test.json includes src as well as test.
import { spawnSync } from "node:child_process";

const PROJECTS = [
  "packages/broker/tsconfig.test.json",
  "packages/providers/tsconfig.test.json",
  "packages/cli/tsconfig.test.json",
  "apps/web/tsconfig.test.json",
  "tsconfig.tools.json",
];

let failed = false;
for (const project of PROJECTS) {
  process.stdout.write(`\n▸ tsc -p ${project}\n`);
  // Serial, and every project runs even after one fails: the point of the command is a complete
  // picture, and stopping at the first would hide the rest behind whichever happened to be listed
  // earliest.
  const r = spawnSync("tsc", ["-p", project], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) failed = true;
}
if (failed) process.exit(1);
