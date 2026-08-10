import { randomBytes } from "node:crypto";
import {
  SupabaseError,
  checkSupabase,
  organisations,
  run,
  supabaseTool,
  tryRun,
} from "../../supabase";
import type { PreflightCheck } from "../../cli-tools";
import type {
  DbHost,
  DbHostContext,
  DbHostLocal,
  DbHostPreflightInput,
  LocalContext,
  Provisioned,
  SavedDatabase,
} from "./types";

const EXAMPLE_REGIONS = "us-east-1, eu-central-1, sa-east-1, ap-southeast-1";

/**
 * The session pooler, on 5432, and why it is the default rather than the direct connection.
 *
 * Three ports are on offer and only one of them is right for warehousd:
 *
 *   - `db.<ref>.supabase.co:5432` — direct. Correct, but increasingly behind the paid IPv4 add-on,
 *     so a URL built this way fails to resolve for a lot of accounts.
 *   - `…pooler.supabase.com:5432` — session mode. Honours connection startup parameters, which
 *     warehousd sets three of, and is available on every plan. This one.
 *   - `…pooler.supabase.com:6543` — transaction mode. Refused outright by the broker's own
 *     provider check, because it silently drops those three parameters.
 *
 * The username carries the tenant through Supavisor (`postgres.<ref>`), which is exactly what
 * `roleUsername` in packages/broker/src/db/providers/supabase.ts already knows how to spell for
 * the four warehousd roles.
 *
 * **This URL is assembled rather than read.** No Supabase CLI command prints a remote project's
 * Postgres URL, so the host, the port and the username shape are warehousd's assumptions about
 * somebody else's product — the most fragile thing in this feature. `db-reachable` in the deploy
 * pre-flight is what catches it being wrong, before an image is built.
 */
function poolerUrl(ref: string, region: string, password: string): string {
  const host = `aws-0-${region}.pooler.supabase.com`;
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:5432/postgres`;
}

/** A project name unique enough that a second deployment cannot adopt the first one's database. */
function projectName(appName: string): string {
  return `${appName}-warehousd-${randomBytes(3).toString("hex")}`;
}

/**
 * The `ref` out of whatever `projects create` printed.
 *
 * The CLI's success output has changed wording across versions, so this looks for the 20-character
 * lowercase id Supabase uses rather than parsing a sentence. Failing to find one is reported, not
 * guessed at: a wrong ref would build a URL pointing at somebody else's project.
 */
function refFromOutput(out: string): string | undefined {
  return /\b([a-z]{20})\b/.exec(out)?.[1];
}

function resolveOrg(ctx: DbHostContext): string {
  if (ctx.org) return ctx.org;
  const orgs = organisations();
  const only = orgs.length === 1 ? orgs[0] : undefined;
  if (only) return only.id;
  throw new SupabaseError(
    orgs.length === 0
      ? `warehousd could not list your Supabase organisations. Check \`supabase login\`, or set deploy.database.org.`
      : `This Supabase account has ${orgs.length} organisations, so warehousd cannot pick one for ` +
          `you. Set deploy.database.org to one of: ${orgs.map((o) => `${o.id} (${o.name})`).join(", ")}`,
  );
}

function preflight(input: DbHostPreflightInput): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [checkSupabase({ platform: process.platform, env: input.env })];

  checks.push({
    id: "supabase-region",
    ok: input.region !== undefined,
    detail:
      input.region !== undefined
        ? `creating the database in ${input.region}`
        : `deploy.database.region is required when Supabase provisions the database — ${EXAMPLE_REGIONS}`,
  });

  // Only when the CLI answered. Asking an unauthenticated CLI to list organisations produces a
  // second failure that says nothing the first one did not.
  if (checks[0]?.ok && input.org === undefined) {
    const orgs = organisations();
    checks.push({
      id: "supabase-org",
      ok: orgs.length === 1,
      detail:
        orgs.length === 1
          ? `creating the project in ${orgs[0]?.name ?? orgs[0]?.id}`
          : `this account has ${orgs.length} Supabase organisations — set deploy.database.org to say which`,
    });
  }

  return Promise.resolve(checks);
}

/**
 * A Supabase project, and the URL warehousd will connect to it on.
 *
 * The password is generated here and is the only copy that will ever exist: `projects create` is
 * the one place it can be set, and nothing reads it back afterwards. deploy.ts writes it into
 * `state.json` at mode 0600 — see `writeDatabaseState` — and it must never reach
 * `outputs.deploy.json`.
 */
// Plain functions handing back a settled promise, the same shape fly.ts and railway.ts use: the
// interface is async because another host may have to poll, while every step here is a single
// `execFileSync`. A refusal is thrown rather than rejected for the same reason — which is what the
// `await host.…` call sites in deploy.ts already handle, and what `require-await` in
// eslint.config.js requires of a function with nothing to await.
function provision(ctx: DbHostContext): Promise<Provisioned> {
  if (!ctx.region) {
    // Pre-flight refuses this, so reaching here without one is our own bug.
    throw new SupabaseError("deploy.database.region is required for Supabase");
  }
  const org = resolveOrg(ctx);
  const name = projectName(ctx.appName);
  const password = randomBytes(24).toString("hex");

  ctx.say(`Creating the Supabase project ${name} in ${ctx.region}…`);
  const out = run([
    "projects",
    "create",
    name,
    "--org-id",
    org,
    "--db-password",
    password,
    "--region",
    ctx.region,
  ]);

  const ref = refFromOutput(out);
  if (!ref) {
    throw new SupabaseError(
      `Supabase accepted the project but warehousd could not read its ref from the CLI's output. ` +
        `Find it with \`supabase projects list\` and set deploy.database.url instead — the ` +
        `password warehousd generated is in .warehousd/state.json.`,
    );
  }

  return Promise.resolve({ url: poolerUrl(ref, ctx.region, password), ref, password });
}

/**
 * Rebuild the URL for a project created on an earlier run.
 *
 * Derived, not asked, because there is nothing to ask: the password exists only in `state.json`.
 * Losing that file means losing the credential, which is why the refusal below says to reset the
 * password rather than pretending anything can be recovered.
 */
function reconnect(ctx: DbHostContext, saved: SavedDatabase): Promise<string> {
  if (!saved.password) {
    throw new SupabaseError(
      `warehousd has no stored password for the Supabase project ${saved.ref}, and Supabase will ` +
        `not hand one back. Reset it in the dashboard, then set deploy.database.url to the ` +
        `session-pooler string (port 5432, not 6543).`,
    );
  }
  if (!ctx.region) {
    throw new SupabaseError("deploy.database.region is required to rebuild the Supabase URL");
  }
  ctx.say(`Reusing the Supabase project ${saved.ref}`);
  return Promise.resolve(poolerUrl(saved.ref, ctx.region, saved.password));
}

function destroy(ctx: DbHostContext, saved: SavedDatabase): Promise<void> {
  // `tryRun` for the same reason Fly's and Neon's teardowns use it: a half-provisioned deploy has
  // to be tearable down, and an error about a project that is already gone helps nobody.
  if (!tryRun(["projects", "delete", saved.ref, "--experimental"]).ok) {
    ctx.say(
      `Could not delete the Supabase project ${saved.ref}. Remove it from the dashboard: https://supabase.com/dashboard`,
    );
  }
  return Promise.resolve();
}

/**
 * `supabase start`, as a local backend for `warehousd start`.
 *
 * Heavier than the pgvector container it replaces — this boots Auth, Storage, Studio and the rest
 * — and worth it for one specific reason: local Supabase installs pgcrypto into an `extensions`
 * schema rather than `public`, exactly as the hosted product does. That is the difference behind
 * the failure docs/deploy-database.md calls the bad one, where apply and boot both succeed and the
 * first masked read fails at request time. Reproducing it on a laptop is the point.
 */
const local: DbHostLocal = {
  async start(ctx: LocalContext): Promise<string> {
    const running = await this.status(ctx);
    if (running) return running;

    // `supabase start` needs a config.toml, and `init` is what writes one. Idempotent, and it
    // refuses harmlessly when the directory already has one.
    tryRun(["init"], { cwd: ctx.projectDir });

    ctx.say("Starting the local Supabase stack — this pulls a dozen images the first time…");
    run(["start"], { cwd: ctx.projectDir });

    const url = await this.status(ctx);
    if (!url) {
      throw new SupabaseError(
        "`supabase start` finished but reported no DB_URL. Check `supabase status` in this directory.",
      );
    }
    return url;
  },

  stop(ctx: LocalContext): Promise<void> {
    // No `--no-backup`: stopping a local stack must not be a way to lose the data in it.
    tryRun(["stop"], { cwd: ctx.projectDir });
    return Promise.resolve();
  },

  /**
   * The local database URL if the stack is up, null otherwise.
   *
   * `-o env` rather than the human table: the env form is a contract, and the table's column
   * layout has changed across releases.
   */
  status(ctx: LocalContext): Promise<string | null> {
    const result = tryRun(["status", "-o", "env"], { cwd: ctx.projectDir });
    if (!result.ok) return Promise.resolve(null);
    const line = /^DB_URL="?([^"\n]+)"?$/m.exec(result.out);
    return Promise.resolve(line?.[1] ?? null);
  },
};

export const supabase: DbHost = {
  id: "supabase",
  label: "Supabase",
  cli: supabaseTool,
  exampleRegions: EXAMPLE_REGIONS,
  preflight,
  provision,
  reconnect,
  destroy,
  local,
};
