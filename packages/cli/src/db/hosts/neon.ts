import { randomBytes } from "node:crypto";
import { NeonError, checkNeon, connectionUri, neonTool, projectId, run, tryRun } from "../../neon";
import type { PreflightCheck } from "../../cli-tools";
import type {
  DbHost,
  DbHostContext,
  DbHostPreflightInput,
  Provisioned,
  SavedDatabase,
} from "./types";

// Neon's regions are `<cloud>-<area>-<direction><digit>` — aws-us-east-1, azure-gwc. Not validated
// by a regex here for the same reason `deploy.region` is not validated in the schema: the shape
// belongs to the provider, changes when they add a cloud, and a stale regex would refuse a region
// that works. What is checked is that one was named at all.
const EXAMPLE_REGIONS = "aws-us-east-1, aws-eu-central-1, aws-sa-east-1, azure-eastus2";

/**
 * `sslmode=require`, added to whatever URL Neon hands back.
 *
 * The broker's own Neon check advises this (packages/broker/src/db/providers/neon.ts) and a
 * project warehousd created should not trip its own advisory on the first run. It is about the
 * client refusing a downgrade rather than about today's connection being in the clear — Neon's
 * proxy negotiates TLS regardless.
 */
function withSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("sslmode")) parsed.searchParams.set("sslmode", "require");
    return parsed.toString();
  } catch {
    // An unparseable URL is Neon's to explain, not ours to mangle. Pass it through and let the
    // capability probe report what actually happens when something dials it.
    return url;
  }
}

/**
 * A project name that is unique enough to find again, and short enough to read.
 *
 * The app name alone would collide with an earlier deployment of the same project in the same
 * account — which is exactly the case where reconnecting to the wrong database is worst.
 */
function projectName(appName: string): string {
  return `${appName}-warehousd-${randomBytes(3).toString("hex")}`;
}

function preflight(input: DbHostPreflightInput): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [checkNeon({ platform: process.platform, env: input.env })];

  // Asked here rather than in the schema, so the refusal can name Neon's own codes. The schema
  // admits a region-less database block because a provider that does not need one exists.
  checks.push({
    id: "neon-region",
    ok: input.region !== undefined,
    detail:
      input.region !== undefined
        ? `creating the database in ${input.region}`
        : `deploy.database.region is required when Neon provisions the database — ${EXAMPLE_REGIONS}; ` +
          `see https://neon.com/docs/introduction/regions`,
  });

  return Promise.resolve(checks);
}

/**
 * A Neon project, and the owner URL it answers on.
 *
 * The easy provider: `--output json` returns a real connection URI, so nothing here is derived
 * and nothing can be derived wrongly. Contrast supabase.ts, where the URL is assembled from a ref
 * and a password because no command prints it.
 */
// Plain functions handing back a settled promise, the same shape fly.ts and railway.ts use: the
// interface is async because another host may have to poll, while every step here is a single
// `execFileSync`. A refusal is thrown rather than rejected for the same reason — which is what the
// `await host.…` call sites in deploy.ts already handle, and what `require-await` in
// eslint.config.js requires of a function with nothing to await.
function provision(ctx: DbHostContext): Promise<Provisioned> {
  if (!ctx.region) {
    // Pre-flight refuses a region-less config for this host, so reaching here without one is a
    // mistake in our own code — hence a throw rather than a refusal.
    throw new NeonError("deploy.database.region is required for Neon");
  }

  const name = projectName(ctx.appName);
  ctx.say(`Creating the Neon project ${name} in ${ctx.region}…`);
  const out = run([
    "projects",
    "create",
    "--name",
    name,
    "--region-id",
    ctx.region,
    "--output",
    "json",
  ]);

  const uri = connectionUri(out);
  const id = projectId(out);
  if (!uri || !id) {
    throw new NeonError(
      `Neon created a project but warehousd could not read its connection string from the CLI's ` +
        `JSON. Find it with \`neon projects list\`, then set deploy.database.url instead.`,
    );
  }

  return Promise.resolve({ url: withSslMode(uri), ref: id });
}

/**
 * The owner URL for a project created on an earlier run.
 *
 * Asked rather than remembered: Neon will hand the connection string back on demand, so there is
 * no reason to keep a password in state.json for it — and a credential not stored is a credential
 * that cannot leak.
 */
function reconnect(ctx: DbHostContext, saved: SavedDatabase): Promise<string> {
  const result = tryRun(["connection-string", "--project-id", saved.ref]);
  const uri = result.ok ? result.out.trim() : "";
  if (!uri.startsWith("postgres")) {
    throw new NeonError(
      `warehousd created the Neon project ${saved.ref} but can no longer read its connection ` +
        `string. If it was deleted, remove the \`database\` block from .warehousd/state.json and ` +
        `deploy again; otherwise check \`neon projects list\`.`,
    );
  }
  ctx.say(`Reusing the Neon project ${saved.ref}`);
  return Promise.resolve(withSslMode(uri));
}

/**
 * `tryRun`, for the same reason Fly's database teardown uses it: a half-provisioned deploy has to
 * be tearable down, and an error about a project that is already gone helps nobody.
 */
function destroy(ctx: DbHostContext, saved: SavedDatabase): Promise<void> {
  if (!tryRun(["projects", "delete", saved.ref]).ok) {
    ctx.say(
      `Could not delete the Neon project ${saved.ref}. Remove it from the console: neon projects list`,
    );
  }
  return Promise.resolve();
}

/**
 * No `local`. Neon is a hosted service with no local stack, so the init wizard never offers it as
 * a local option and `database.provider: neon` is refused with that sentence.
 */
export const neon: DbHost = {
  id: "neon",
  label: "Neon",
  cli: neonTool,
  exampleRegions: EXAMPLE_REGIONS,
  preflight,
  provision,
  reconnect,
  destroy,
};
