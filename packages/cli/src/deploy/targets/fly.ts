import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkFly, run, tryRun, appExists } from "../../fly";
import { resolveBaseImage, renderDeployDockerfile, renderFlyToml } from "../fly-toml";
import type { PreflightCheck } from "../preflight";
import type { DeployTarget, TargetContext, TargetPreflightInput } from "./types";

// Fly's regions are three-letter slugs — gru, iad, sjc. This used to be a regex on DeploySchema,
// which meant the broker knew one target's slug format and a Railway region (`us-west2`) could not
// be expressed at all. It lives here now, where it can name Fly in the refusal.
const FLY_REGION = /^[a-z]{3}$/;

/** `${appName}-db`, the app `postgres create` makes and `postgres attach` wires to the app. */
function dbAppName(appName: string): string {
  return `${appName}-db`;
}

// Every method below returns a promise because the interface is async — Railway's target waits on
// HTTP, and a Compose file waits on nothing at all. Fly's runbook is `execFileSync` throughout, so
// these are plain functions handing back a settled promise rather than `async` ones with nothing to
// await; `deploy` is the one that genuinely has an await in it.
function preflight(input: TargetPreflightInput): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  // `input.env` rather than `process.env`: the install line this suggests depends on which package
  // manager the machine has, and a check that reads the ambient environment cannot be tested
  // against a machine other than the one running the suite.
  checks.push(checkFly({ platform: process.platform, env: input.env }));

  // Only when there is a region to judge. With no `deploy:` block there is nothing to say, and a
  // check that reports "not evaluated" on every `warehousd doctor` run in a project that has never
  // deployed is noise standing where a real answer should be.
  const region = input.cfg?.deploy?.region;
  if (region !== undefined) {
    checks.push({
      id: "fly-region",
      ok: FLY_REGION.test(region),
      detail: FLY_REGION.test(region)
        ? `deploying to ${region}`
        : `region "${region}" is not a Fly region code. Fly uses three letters — gru, iad, sjc; ` +
          `see https://fly.io/docs/reference/regions/`,
    });
  } else if (input.cfg?.deploy) {
    // The schema no longer demands a region — Compose has none — so a Fly deploy that omitted it
    // has to be refused here, before `apps create` runs with nowhere to put the machines.
    checks.push({
      id: "fly-region",
      ok: false,
      detail: "deploy.region is required for Fly — three letters, e.g. gru, iad, sjc",
    });
  }

  return Promise.resolve(checks);
}

function ensureApp(ctx: TargetContext): Promise<void> {
  if (!appExists(ctx.appName)) {
    run(["apps", "create", ctx.appName]);
  }
  return Promise.resolve();
}

// `null` is the point, not an omission. `postgres attach` generates a user and password and sets
// DATABASE_URL on the app itself; those credentials are Fly's, are shown once, and cannot be read
// back out. Any URL invented here — the old code built one from the *local* Docker password in
// state.json — would simply be wrong. The entrypoint falls back to DATABASE_URL, which is the value
// that actually works.
// Preflight refuses a region-less config for this target, so reaching either call site without
// one is a mistake in our own code — hence a throw, not a refusal.
function requireRegion(ctx: TargetContext): string {
  if (!ctx.region) throw new Error("deploy.region is required for Fly");
  return ctx.region;
}

function provisionDatabase(ctx: TargetContext): Promise<string | null> {
  const dbApp = dbAppName(ctx.appName);
  if (!appExists(dbApp)) {
    run(["postgres", "create", "--name", dbApp, "--region", requireRegion(ctx)]);
    run(["postgres", "attach", "--app", ctx.appName, dbApp]);
  }
  return Promise.resolve(null);
}

function setSecrets(ctx: TargetContext, lines: string[]): Promise<void> {
  run(["secrets", "import", "--app", ctx.appName, "--stage"], { input: lines.join("\n") });
  return Promise.resolve();
}

async function deploy(ctx: TargetContext): Promise<void> {
  const dockerfilePath = join(ctx.deployDir, "Dockerfile");
  writeFileSync(dockerfilePath, renderDeployDockerfile(resolveBaseImage(ctx.cfg)));

  const flyTomlPath = join(ctx.deployDir, "fly.toml");
  writeFileSync(flyTomlPath, renderFlyToml({ appName: ctx.appName, region: requireRegion(ctx) }));

  // The bundle dir is the build context — flyctl defaults to the process cwd, where the
  // Dockerfile's `COPY context /project` has nothing to copy.
  const deployArgs = [
    "deploy",
    ctx.deployDir,
    "--config",
    flyTomlPath,
    "--dockerfile",
    dockerfilePath,
  ];
  if (!ctx.localBuild) {
    deployArgs.push("--remote-only");
  } else {
    // Local build needs Docker to be available. Imported here rather than at the top so a remote
    // build never loads the Docker probe at all.
    const docker = await import("../../docker");
    docker.assertRuntime();
    // flyctl defaults to its remote builder even without --remote-only, so a base image that only
    // exists in the local daemon never resolves there. --local-only is what makes this flag real.
    deployArgs.push("--local-only");
  }

  run(deployArgs);
}

// `tryRun` throughout, and for the same reason on both lines: a teardown has to be able to finish
// against a half-provisioned deploy. The app itself used to be a `run` — so a deploy that failed
// before `apps create`, or a second `--destroy`, threw on the app that was already gone and never
// reached the database app, leaving the expensive half standing. Railway's destroy already worked
// this way.
function destroy(ctx: TargetContext): Promise<void> {
  if (!tryRun(["apps", "destroy", ctx.appName, "--yes"]).ok) {
    ctx.say(`No app ${ctx.appName} to destroy.`);
  }

  if (ctx.deploy.database.managed) {
    const dbApp = dbAppName(ctx.appName);
    if (!tryRun(["apps", "destroy", dbApp, "--yes"]).ok) {
      ctx.say(`No database app ${dbApp} to destroy.`);
    }
  }
  return Promise.resolve();
}

function appUrl(ctx: TargetContext): Promise<string | null> {
  return Promise.resolve(`https://${ctx.appName}.fly.dev`);
}

function logs(ctx: TargetContext): Promise<string> {
  return Promise.resolve(run(["logs", "--app", ctx.appName]));
}

export const fly: DeployTarget = {
  id: "fly",
  label: "Fly.io",
  blurb: "warehousd creates the app and runs it for you",
  databaseHint: "managed by Fly Postgres — `fly postgres connect`",
  exampleRegion: "gru",
  preflight,
  ensureApp,
  provisionDatabase,
  setSecrets,
  deploy,
  destroy,
  appUrl,
  logs,
};
