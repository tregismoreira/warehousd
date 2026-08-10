import { confirm as clackConfirm, text, select, isCancel, cancel } from "@clack/prompts";
import {
  dbProviders,
  type ContainerRuntimeId,
  type DbProviderId,
  type DeployTargetId,
} from "@warehousd/broker";
import { targets } from "../deploy/targets";
import { runtimes } from "../containers/runtimes";
import { dbHosts, hostFor, localHosts } from "../db/hosts";

// The only module that talks to @clack/prompts.
//
// Pinned to ^0.11 deliberately: 1.x is ESM-only (no `require` condition), and this package builds
// to a CommonJS bundle (tsup.config.ts, bin dist/index.cjs). Do not widen that range without
// moving the build to ESM first.
//
// Every entry point here is gated on an interactive stdin. clig.dev's rule, and the practical
// reason behind it: `packages/cli/test/e2e/lifecycle.e2e.test.ts` drives this binary through
// `execFileSync` with `stdio: "pipe"`, so a prompt that did not check would hang the suite
// forever rather than fail it. Non-interactive callers get an error naming the flag to pass.

export function isInteractive(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
}

export class NonInteractiveError extends Error {}

export async function confirm(opts: {
  message: string;
  flag: string;
  interactive?: boolean | undefined;
  initialValue?: boolean | undefined;
}): Promise<boolean> {
  const interactive = opts.interactive ?? isInteractive();
  if (!interactive) {
    throw new NonInteractiveError(`${opts.message} Re-run with ${opts.flag} to confirm.`);
  }
  const answer = await clackConfirm({
    message: opts.message,
    initialValue: opts.initialValue ?? false,
  });
  if (isCancel(answer)) {
    cancel("Cancelled.");
    return false;
  }
  return answer;
}

/**
 * Two database answers, not one.
 *
 * `managed` is about the *local* stack — whether the CLI runs Postgres in Docker on this machine.
 * `deployManaged` is about production. They were one flag, so choosing a deploy provider also
 * rewrote the local block to `${env:DATABASE_URL}` and "Docker locally, Supabase in production" —
 * the ordinary case — could not be scaffolded at all.
 *
 * `dbProvider` is null exactly when `deployManaged` is true: under `managed` the target provisions
 * the database and knows what it built, and `DeploySchema` refuses a `provider` with no `url` for
 * that reason — it would name where a database that does not exist here is hosted.
 */
export type InitAnswers = {
  project: string;
  port: number;
  managed: boolean;
  target: DeployTargetId;
  deployManaged: boolean;
  dbProvider: DbProviderId | null;
  /**
   * Guided or manual.
   *
   * Manual is the escape hatch and stays first-class: it prompts for connection strings, touches
   * no package manager, and creates nothing remote. Guided is the default because the whole point
   * of the provider registries is that pasting a URL should not be the only way in.
   */
  guided: boolean;
  /** Which container engine `warehousd start` drives. */
  runtime: ContainerRuntimeId;
  /**
   * Whose local stack runs the development database, when it is not warehousd's own container.
   *
   * Only ever a host with a `local` — Neon has none, so it is not offered here even though it is
   * offered for production.
   */
  localDbProvider: DbProviderId | null;
  /** The database's own region, which is not the deploy target's. */
  dbRegion: string | null;
  /**
   * Which organisation to create it in.
   *
   * Supabase's, and only needed when the account has more than one — `projects create` takes an
   * `--org-id` and warehousd will not guess between two. Null everywhere else.
   */
  dbOrg: string | null;
};

/**
 * Both selects below are built by mapping a registry, so a fourth target or provider appears in
 * the wizard with no edit to this file — the same property the registries exist for.
 */
function optionsFrom(registry: Record<string, { id: string; label: string }>) {
  return Object.values(registry).map((e) => ({ value: e.id, label: e.label }));
}

export async function promptInit(defaults: InitAnswers): Promise<InitAnswers | null> {
  const project = await text({
    message: "Project name",
    placeholder: defaults.project,
    defaultValue: defaults.project,
    validate: (v) =>
      v && !/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(v)
        ? "Letters, numbers, spaces, dashes and underscores only."
        : undefined,
  });
  if (isCancel(project)) return null;

  const port = await text({
    message: "Server port",
    placeholder: String(defaults.port),
    defaultValue: String(defaults.port),
    validate: (v) => {
      if (!v) return undefined;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 && n < 65536 ? undefined : "Not a port number.";
    },
  });
  if (isCancel(port)) return null;

  // Before anything else, because it decides whether the rest of the wizard is about *choosing*
  // services or about *describing* ones that already exist.
  const mode = await select({
    message: "How do you want to set this up?",
    options: [
      {
        value: "guided",
        label: "Guided — warehousd creates and connects everything",
        hint: "recommended",
      },
      { value: "manual", label: "Manual — I'll paste connection details myself" },
    ],
    initialValue: defaults.guided ? "guided" : "manual",
  });
  if (isCancel(mode)) return null;
  const guided = mode === "guided";

  // Which engine runs the containers. Asked before the database, because a local database that is
  // a container needs one — and because "warehousd could not find docker" is a better first
  // sentence than a failure four questions later.
  const runtime = guided
    ? await select({
        message: "Container engine",
        options: optionsFrom(runtimes),
        initialValue: String(defaults.runtime),
      })
    : defaults.runtime;
  if (isCancel(runtime)) return null;
  const runtimeId = idIn(runtime, runtimes, defaults.runtime);

  // Local, and about this machine only — the deploy question comes after the target, below. One
  // question used to answer both, which made "Docker locally, Supabase in production"
  // unscaffoldable.
  //
  // The provider options are mapped from the registry rather than listed, so a third host with a
  // local stack appears here with no edit to this file.
  const localOptions = [
    { value: "managed", label: "Let warehousd run Postgres in a container", hint: "recommended" },
    ...(guided
      ? localHosts().map((host) => ({
          value: host.id,
          label: `Run ${host.label} locally`,
          hint: `${host.cli.bin} start`,
        }))
      : []),
    { value: "external", label: "Bring my own, via database.url" },
  ];
  const database = await select({
    message: "Database for local development",
    options: localOptions,
    initialValue: defaults.localDbProvider ?? (defaults.managed ? "managed" : "external"),
  });
  if (isCancel(database)) return null;
  // A provider answer is still `managed` in the config's terms — warehousd runs the database
  // either way; `provider` only says whose stack does the running.
  const localDbProvider = database in dbProviders ? (database as DbProviderId) : null;
  const managed = database === "managed" || localDbProvider !== null;

  const target = await select({
    message: "Deploy target",
    options: optionsFrom(targets),
    initialValue: String(defaults.target),
  });
  if (isCancel(target)) return null;
  const targetId = idIn(target, targets, defaults.target);

  // Asked after the target, because it is the target that would provision one by default. The
  // three answers are the three shapes `deploy.database` takes — see DeploySchema.
  const deployDatabase = await select({
    message: `Database in production, on ${targets[targetId].label}`,
    options: [
      { value: "managed", label: `Let ${targets[targetId].label} provision Postgres` },
      ...(guided
        ? Object.values(dbHosts).map((host) => ({
            value: host.id,
            label: `Let warehousd create one on ${host.label}`,
            hint: `${host.cli.bin} projects create`,
          }))
        : []),
      { value: "external", label: "Attach a Postgres I already run" },
    ],
    initialValue: defaults.deployManaged ? "managed" : (defaults.dbProvider ?? "external"),
  });
  if (isCancel(deployDatabase)) return null;

  // `provider` now means one of two things depending on which branch we are in, so both are
  // resolved here rather than left for the caller to infer.
  const provisioningHost = hostFor(deployDatabase as DbProviderId);
  const deployManaged = deployDatabase === "managed" || provisioningHost !== undefined;

  let dbProvider: DbProviderId | null = provisioningHost?.id ?? null;
  let dbRegion: string | null = null;
  let dbOrg: string | null = null;

  if (provisioningHost) {
    // The database's own region. Free text rather than a select: these lists change as providers
    // add capacity, and a stale hard-coded set would refuse a region that works — the same
    // reasoning that keeps a region regex out of DeploySchema.
    const region = await text({
      message: `Region for the ${provisioningHost.label} database`,
      placeholder: provisioningHost.exampleRegions,
      defaultValue: "",
      validate: (v) => (v ? undefined : `Required — e.g. ${provisioningHost.exampleRegions}`),
    });
    if (isCancel(region)) return null;
    dbRegion = String(region);

    // Only where the provider has organisations to choose between. Blank is the ordinary answer:
    // an account with one org needs no `--org-id`, and the host resolves it silently.
    if (provisioningHost.id === "supabase") {
      const org = await text({
        message: "Supabase organisation id (leave blank if you have only one)",
        placeholder: "detected from `supabase orgs list`",
        defaultValue: "",
      });
      if (isCancel(org)) return null;
      dbOrg = String(org) || null;
    }
  } else if (!deployManaged) {
    // Attaching one you already run: `provider` is the override it has always been, and only
    // matters where the hostname does not say who hosts it.
    const provider = await select({
      message: "Who hosts that Postgres",
      options: optionsFrom(dbProviders),
      initialValue: String(defaults.dbProvider ?? "generic"),
    });
    if (isCancel(provider)) return null;
    dbProvider = idIn(provider, dbProviders, "generic");
  }

  return {
    project: String(project) || defaults.project,
    port: Number(port) || defaults.port,
    managed,
    target: targetId,
    deployManaged,
    dbProvider,
    guided,
    runtime: runtimeId,
    localDbProvider,
    dbRegion,
    dbOrg,
  };
}

/**
 * Narrow a select's answer back to a registry id.
 *
 * The options came from the registry, so the `in` can only fail if clack handed back something
 * else entirely — but proving membership beats asserting it, which is what `noUncheckedIndexedAccess`
 * and `strict` are on for.
 */
function idIn<T extends string>(value: unknown, registry: Record<string, unknown>, fallback: T): T {
  return typeof value === "string" && value in registry ? (value as T) : fallback;
}
