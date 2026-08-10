import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RailwayError, checkRailway, linkedProject, run, tryRun } from "../../railway";
import { resolveBaseImage, renderDeployDockerfile } from "../fly-toml";
import type { PreflightCheck } from "../preflight";
import type { DeployTarget, TargetContext, TargetPreflightInput } from "./types";

// Railway's regions are `<area>-<direction><digit>`, optionally with a metal suffix — us-west2,
// europe-west4-drams3a. Nothing like Fly's three letters, which is why DeploySchema stopped
// validating the shape of this field and each target checks its own (PR 3).
const RAILWAY_REGION = /^[a-z]+-[a-z]+\d+(-[a-z0-9]+)?$/;

// A handful of the real ones, for the refusal to point somewhere concrete rather than at a regex.
const EXAMPLE_REGIONS = "us-west2, us-east4, europe-west4, asia-southeast1";

/** The service name `railway add --database postgres` creates. */
const DB_SERVICE = "Postgres";

/**
 * The port the image listens on, which Railway has to be told twice.
 *
 * Once as `PORT` in the service's variables, because Railway has no `fly.toml [env]` equivalent;
 * once on `railway domain`, because generating a domain otherwise depends on Railway having
 * detected a port from a running deployment — and on a first deploy there is none. It was a
 * literal in both places.
 */
const CONTAINER_PORT = 8722;

/** How long to wait for `railway add --database postgres` to finish provisioning, and how often. */
const DB_READY_TIMEOUT_MS = 30_000;
const DB_READY_INTERVAL_MS = 2000;

/**
 * Railway's config-as-code file, read from the root of whatever `railway up` uploads.
 *
 * It is this target's `fly.toml`, and it carries the same two things for the same reasons:
 *
 * - `healthcheckPath` is what keeps watching after the deploy returns. `runDeploy` polls
 *   `/api/health` once itself; without this, nothing notices a container that wedges an hour later
 *   and it stays in rotation serving errors.
 * - `multiRegionConfig` is the only place `deploy.region` can take effect — Railway has no
 *   `--region` flag on any CLI command, so a region validated at pre-flight and then dropped would
 *   be a config key that reads as though it decided something.
 *
 * There is no `release_command` equivalent, so unlike Fly the image's own CMD is left alone: it is
 * `entrypoint && next start`, which bootstraps and then serves in the one container.
 */
export function renderRailwayJson(o: { region: string }): string {
  return `${JSON.stringify(
    {
      $schema: "https://railway.com/railway.schema.json",
      build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
      deploy: {
        healthcheckPath: "/api/health",
        healthcheckTimeout: 30,
        restartPolicyType: "ON_FAILURE",
        multiRegionConfig: { [o.region]: { numReplicas: 1 } },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The service's variables as a flat object.
 *
 * `--json` is the contract; a body that does not parse is reported as such rather than as an empty
 * set, because "this service has no DATABASE_URL" and "the CLI answered something unexpected" lead
 * to different fixes.
 */
function variables(ctx: TargetContext, service: string): Record<string, string> {
  const out = run(["variables", "--service", service, "--json"], { cwd: ctx.projectDir });
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new RailwayError(`Could not read ${service}'s variables: railway did not return JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new RailwayError(`Could not read ${service}'s variables: railway did not return JSON`);
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function preflight(input: TargetPreflightInput): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  // `input.env` rather than `process.env` — see the same note in fly.ts.
  const readyCheck = checkRailway({ platform: process.platform, env: input.env });
  const ready = readyCheck.ok;
  checks.push(readyCheck);

  // Only when there is a region to judge — a project that has never deployed has none, and a
  // permanent "not evaluated" line on every `warehousd doctor` run stands where a real answer
  // should be.
  const region = input.cfg?.deploy?.region;
  if (region !== undefined) {
    const ok = RAILWAY_REGION.test(region);
    checks.push({
      id: "railway-region",
      ok,
      detail: ok
        ? `deploying to ${region}`
        : `region "${region}" is not a Railway region code. Railway uses ${EXAMPLE_REGIONS}; ` +
          `see https://docs.railway.com/reference/deployment-regions`,
    });
  } else if (input.cfg?.deploy) {
    // Same reasoning as Fly's: the schema admits a region-less deploy block for Compose's sake,
    // so a target with regions has to demand one itself.
    checks.push({
      id: "railway-region",
      ok: false,
      detail: `deploy.region is required for Railway — ${EXAMPLE_REGIONS}`,
    });
  }

  // Which project this directory is linked to is the one thing that can silently send a deploy
  // somewhere the config does not name. Nothing linked is fine — `ensureApp` creates it. A
  // different project is not: `railway up` would ship into it without ever mentioning app_name.
  const appName = input.cfg?.deploy?.app_name;
  if (ready && appName !== undefined) {
    const linked = linkedProject(input.projectDir);
    const ok = linked === null || linked.name === appName;
    checks.push({
      id: "railway-project",
      ok,
      detail: ok
        ? linked === null
          ? `no project linked yet; deploy will create "${appName}"`
          : `linked to "${linked.name}"`
        : `this directory is linked to the Railway project "${linked.name}", but deploy.app_name ` +
          `is "${appName}". Run \`railway unlink\`, or change app_name to match.`,
    });
  }

  return Promise.resolve(checks);
}

/**
 * A linked project with a service of its own to deploy into.
 *
 * Both halves are idempotent, and both are needed: `railway init` links a project but leaves it
 * empty, and `railway up` against a project with no service picks one by prompting — which, in a
 * deploy, means failing on a closed stdin.
 */
// Plain functions handing back a settled promise, the same shape fly.ts uses: the interface is
// async because another target waits on HTTP, while every Railway step here is `execFileSync`.
// A refusal is thrown rather than rejected for the same reason, which is what `runDeploy`'s
// `await target.…` call sites already handle.
function ensureApp(ctx: TargetContext): Promise<void> {
  let linked = linkedProject(ctx.projectDir);
  if (linked === null) {
    run(["init", "--name", ctx.appName], { cwd: ctx.projectDir });
    linked = linkedProject(ctx.projectDir);
  }

  if (!linked?.services.includes(ctx.appName)) {
    run(["add", "--service", ctx.appName], { cwd: ctx.projectDir });
  }
  return Promise.resolve();
}

/**
 * Railway's own Postgres, and the URL it answers on.
 *
 * Unlike Fly this returns a real URL rather than null: `railway add --database postgres` sets
 * DATABASE_URL on the *database* service, not on the app, so nothing injects it into the container
 * unless this does. The private hostname is preferred — the app runs inside the same project, and
 * `*.railway.internal` skips the public proxy and its egress. The public one is the fallback for a
 * project where private networking is off.
 *
 * The plain container behind it has a superuser `POSTGRES_USER` and no pooler, so `create role` and
 * `create extension` work with no special handling (packages/broker/src/db/providers/railway.ts).
 */
async function provisionDatabase(ctx: TargetContext): Promise<string | null> {
  const linked = linkedProject(ctx.projectDir);
  if (!linked?.services.includes(DB_SERVICE)) {
    run(["add", "--database", "postgres"], { cwd: ctx.projectDir });
  }

  // `railway add` returns once Railway has accepted the request, not once the database exists —
  // provisioning continues on their side. Reading the variables straight afterwards therefore sees
  // no DATABASE_URL on a first deploy, which used to be reported as "check the database
  // provisioned cleanly" on the happy path. The retry is the whole difference between that and
  // waiting the few seconds it takes. `add` is deliberately outside the loop: it is not
  // idempotent, and a second one would provision a second database.
  const deadline = Date.now() + DB_READY_TIMEOUT_MS;
  for (;;) {
    const vars = variables(ctx, DB_SERVICE);
    const url = vars.DATABASE_URL ?? vars.DATABASE_PUBLIC_URL;
    if (url) return url;
    if (Date.now() >= deadline) {
      throw new RailwayError(
        `Railway's ${DB_SERVICE} service reported no DATABASE_URL or DATABASE_PUBLIC_URL after ` +
          `${DB_READY_TIMEOUT_MS / 1000}s. Check the database provisioned cleanly: railway open`,
      );
    }
    ctx.say(`Waiting for Railway to finish provisioning ${DB_SERVICE}…`);
    await new Promise((resolve) => setTimeout(resolve, DB_READY_INTERVAL_MS));
  }
}

/**
 * The generated credentials, plus the three environment values Fly gets from `fly.toml`'s `[env]`.
 *
 * Railway has no such file — `railway.json` configures the build and the deploy, not the
 * environment — so the container's PORT, project directory and NODE_ENV have to travel the same
 * channel the secrets do. WAREHOUSD_DEMO stays deliberately absent, exactly as in `fly.toml`: its
 * absence is what keeps demo personas from being seeded.
 *
 * Every value goes in one invocation. Railway triggers a redeploy per `variables` call, and one
 * call per line would queue a dozen of them ahead of the deploy that matters.
 */
function setSecrets(ctx: TargetContext, lines: string[]): Promise<void> {
  const args = ["variables", "--service", ctx.appName];
  for (const line of [
    ...lines,
    `PORT=${CONTAINER_PORT}`,
    "WAREHOUSD_PROJECT_DIR=/project",
    "NODE_ENV=production",
  ]) {
    args.push("--set", line);
  }
  run(args, { cwd: ctx.projectDir });
  return Promise.resolve();
}

function deploy(ctx: TargetContext): Promise<void> {
  writeFileSync(
    join(ctx.deployDir, "Dockerfile"),
    renderDeployDockerfile(resolveBaseImage(ctx.cfg)),
  );
  // Preflight refuses a region-less config for this target; reaching here without one is our bug.
  if (!ctx.region) throw new Error("deploy.region is required for Railway");
  writeFileSync(join(ctx.deployDir, "railway.json"), renderRailwayJson({ region: ctx.region }));

  // `--detach` returns once Railway has accepted the upload. What follows is `runDeploy`'s poll of
  // /api/health, which is a truer answer about the release than the build log is.
  //
  // `deployDir` and not `contextDir`: the Dockerfile and railway.json sit beside the bundle, and
  // `COPY context /project` resolves against the directory that was uploaded.
  //
  // The bundle is selected by cwd, not by the PATH argument: railway CLI v5 uploads "the current
  // directory" and a PATH pointing elsewhere is silently ignored, so Railpack analyzed the project
  // dir, found no Dockerfile and failed the build.
  //
  // `--local-build` has no meaning here. Railway builds remotely, always; there is no equivalent
  // of `flyctl deploy --remote-only` to opt out of, and no Docker daemon involved on this machine.
  run(["up", "--detach", "--service", ctx.appName], { cwd: ctx.deployDir });
  return Promise.resolve();
}

/**
 * The whole project, which is the unit `ensureApp` created — deleting the app service alone would
 * leave the managed Postgres, and its data, running and billable.
 *
 * Refuses when the linked project is not the one the config names: `railway delete` takes the
 * project it finds linked, and an operator who linked an existing project by hand may have other
 * services in it. `tryRun` for the same reason Fly's database teardown uses it — a half-provisioned
 * deploy must still be tearable-down, and an error with nothing left to retry helps nobody.
 */
function destroy(ctx: TargetContext): Promise<void> {
  const linked = linkedProject(ctx.projectDir);
  if (linked !== null && linked.name !== ctx.appName) {
    throw new RailwayError(
      `This directory is linked to the Railway project "${linked.name}", not "${ctx.appName}". ` +
        `Refusing to delete a project the config does not name.`,
    );
  }

  // `--project` is explicit because without a terminal the CLI refuses to infer it from the link,
  // and the guard above has already pinned the link to this very name.
  if (!tryRun(["delete", "--yes", "--project", ctx.appName], { cwd: ctx.projectDir }).ok) {
    ctx.say(
      `Could not delete the Railway project ${ctx.appName}. Remove it from the dashboard: railway open`,
    );
  }
  return Promise.resolve();
}

/** The hostname out of `railway domain --json`, whichever key this CLI version spells it with. */
function hostFromJson(out: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const body = parsed as { domain?: unknown; domains?: unknown };
  if (typeof body.domain === "string" && body.domain) return stripScheme(body.domain);
  const first = Array.isArray(body.domains) ? body.domains[0] : undefined;
  if (typeof first === "string" && first) return stripScheme(first);
  if (typeof first === "object" && first !== null) {
    const domain = (first as { domain?: unknown }).domain;
    if (typeof domain === "string" && domain) return stripScheme(domain);
  }
  return undefined;
}

function stripScheme(host: string): string {
  return host.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * The service's public hostname, generating one if it has none.
 *
 * `--port` is what makes that generation work on a *first* deploy. `runDeploy` calls `appUrl`
 * before `deploy`, because BETTER_AUTH_URL has to be in the secrets the release reads — so the
 * service has no deployment yet and Railway has no port to infer. Without the flag it declines,
 * `tryRun` swallows it, and the refusal below fired on the happy path.
 *
 * Three sources, in order of how much they are a contract. `--json` is the one worth relying on;
 * the regex over the printed line stays behind it because the wording has changed across CLI
 * versions and older ones print rather than serialise; RAILWAY_PUBLIC_DOMAIN is what a service
 * that already had a domain reports when `domain` says only that it already has one.
 */
function appUrl(ctx: TargetContext): Promise<string | null> {
  // The flagged form first. A CLI old enough not to know `--port` or `--json` rejects the whole
  // invocation rather than ignoring the flag, and that must not be a deploy with no domain: the
  // bare form is what every version has always understood, and it still generates one — just
  // without the port hint that makes it work before the first deployment exists.
  let out = tryRun(
    ["domain", "--service", ctx.appName, "--port", String(CONTAINER_PORT), "--json"],
    { cwd: ctx.projectDir },
  ).out;
  if (out === "") {
    out = tryRun(["domain", "--service", ctx.appName], { cwd: ctx.projectDir }).out;
  }

  const printed = /([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(out.replace(/^https?:\/\//gm, ""));
  const host =
    hostFromJson(out) ?? printed?.[1] ?? variables(ctx, ctx.appName).RAILWAY_PUBLIC_DOMAIN;

  if (!host) {
    throw new RailwayError(
      `Railway has no public domain for ${ctx.appName} and would not generate one. ` +
        `Add one in the service's Networking settings and deploy again.`,
    );
  }
  return Promise.resolve(`https://${host}`);
}

function logs(ctx: TargetContext): Promise<string> {
  return Promise.resolve(tryRun(["logs", "--service", ctx.appName], { cwd: ctx.projectDir }).out);
}

export const railway: DeployTarget = {
  id: "railway",
  label: "Railway",
  databaseHint: "managed by Railway Postgres — `railway connect Postgres`",
  exampleRegion: "us-west2",
  preflight,
  ensureApp,
  provisionDatabase,
  setSecrets,
  deploy,
  destroy,
  appUrl,
  logs,
};
