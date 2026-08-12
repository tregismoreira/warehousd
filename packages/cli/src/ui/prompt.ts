import { confirm as clackConfirm, text, select, isCancel, cancel } from "@clack/prompts";
import {
  dbProviders,
  DEFAULT_DEPLOY_TARGET_ID,
  type DbProviderId,
  type DeployTargetId,
} from "@warehousd/broker";
import { targets } from "../deploy/targets";
import { dbHosts, hostFor, localHosts } from "../db/hosts";
import { rail } from "./frame";
import { resolveTheme, type Theme } from "./theme";

// The only module that talks to @clack/prompts.
//
// @clack/prompts is ESM-only — `"type": "module"`, no `require` condition — and this package
// builds to a CommonJS bundle (tsup.config.ts, bin dist/index.cjs). The two coexist because
// `noExternal: [/.*/]` inlines it, so nothing `require`s it at runtime. Adding it to `external`
// there is what would break the shipped binary; the version range is not the fragile part.
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
  /**
   * Where a deploy would go, or `null` for "not yet".
   *
   * Null is a real answer rather than a missing one. `deploy:` is read only by `warehousd deploy`,
   * and scaffolding a block for somebody who has not chosen a target means writing an app name, a
   * region and a database shape they now have to review before the file is trustworthy. The wizard
   * offers it explicitly and a non-interactive run gets it by default.
   */
  target: DeployTargetId | null;
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
 * Every select below is built by mapping a registry, so a fourth target or provider appears in the
 * wizard with no edit to this file — the same property the registries exist for. `blurb` rides
 * along as the hint, which is where the difference between two similar-sounding options gets said.
 */
function optionsFrom(registry: Record<string, { id: string; label: string; blurb: string }>) {
  return Object.values(registry).map((e) => ({ value: e.id, label: e.label, hint: e.blurb }));
}

/**
 * The value meaning "no deploy block", which is not a target id and must not collide with one.
 *
 * `DEPLOY_TARGET_IDS` is the set it has to stay clear of; `idIn` proves membership against the
 * registry, so anything else falls through to null on its own.
 */
const NO_TARGET = "none";

/**
 * How the wizard says its two halves out loud.
 *
 * This was a clack `note()`, which draws its own little box — and a box in the middle of a rail is
 * the flow visibly breaking in two. It is rail text now, on the same stream clack writes to, so
 * the wizard reads as one column from `┌ Welcome to warehousd` to the last answer.
 */
export type PromptIO = {
  theme?: Theme | undefined;
  say?: ((line: string) => void) | undefined;
};

function sectionWriter(io: PromptIO | undefined): (heading: string, blurb: string) => void {
  const theme =
    io?.theme ?? resolveTheme({ isTTY: Boolean(process.stdout.isTTY), env: process.env });
  const say = io?.say ?? ((line: string) => process.stdout.write(`${line}\n`));
  return (heading, blurb) => {
    say(rail(["", theme.c.bold(heading), theme.c.dim(blurb)], theme));
  };
}

export async function promptInit(
  defaults: InitAnswers,
  io?: PromptIO,
): Promise<InitAnswers | null> {
  const section = sectionWriter(io);
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
    message: "How should warehousd set this up?",
    options: [
      {
        value: "guided",
        label: "Guided",
        hint: "create and connect everything for me",
      },
      { value: "manual", label: "Manual", hint: "I'll paste connection details myself" },
    ],
    initialValue: defaults.guided ? "guided" : "manual",
  });
  if (isCancel(mode)) return null;
  const guided = mode === "guided";

  /**
   * The two halves, said out loud.
   *
   * There are two independent database questions here — one about this laptop, one about
   * production — and the single most common misreading of this wizard was that they were the same
   * question asked twice. They are not: "a container locally, Supabase in production" is the
   * ordinary answer. A heading before each group is the cheapest way to make the split visible
   * instead of something you have to infer from two similar prompts four questions apart.
   */
  section("On this machine", "Where warehousd runs while you develop.");

  // Every option opens with *where the data is*, so the list reads as three answers to one
  // question rather than three sentences about what warehousd will do. The provider options are
  // mapped from the registry, so a third host with a local stack appears here with no edit.
  const localOptions = [
    {
      value: "managed",
      label: "In a container warehousd runs",
      hint: "recommended — nothing to install",
    },
    ...(guided
      ? localHosts().map((host) => ({
          value: host.id,
          label: `In my ${host.label} local stack`,
          hint: `${host.cli.bin} start`,
        }))
      : []),
    { value: "external", label: "In a Postgres I point it at", hint: "you supply database.url" },
  ];
  const database = await select({
    message: "Where should your development data live?",
    options: localOptions,
    initialValue: defaults.localDbProvider ?? (defaults.managed ? "managed" : "external"),
  });
  if (isCancel(database)) return null;
  // A provider answer is still `managed` in the config's terms — warehousd runs the database
  // either way; `provider` only says whose stack does the running.
  const localDbProvider = database in dbProviders ? (database as DbProviderId) : null;
  const managed = database === "managed" || localDbProvider !== null;

  section("In production", "Read only by `warehousd deploy`. Skippable — you can add it later.");

  const target = await select({
    message: "Where will you deploy this?",
    options: [
      ...optionsFrom(targets),
      // Somebody trying warehousd for the first time has not chosen a host yet, and scaffolding a
      // deploy block for them means an app name, a region and a database shape they now have to
      // review. Until this option existed there was no way to say so and `init` guessed instead.
      {
        value: NO_TARGET,
        label: "Not yet — I'll set this up later",
        hint: "leaves the deploy block commented out",
      },
    ],
    initialValue: String(defaults.target ?? NO_TARGET),
  });
  if (isCancel(target)) return null;
  const targetId =
    target === NO_TARGET
      ? null
      : idIn(target, targets, defaults.target ?? DEFAULT_DEPLOY_TARGET_ID);

  const answers = {
    project: String(project) || defaults.project,
    port: Number(port) || defaults.port,
    managed,
    guided,
    localDbProvider,
  };

  // No target, no `deploy.database` to describe: the remaining questions all fill in a block that
  // is not going to be written.
  if (targetId === null) {
    return {
      ...answers,
      target: null,
      deployManaged: true,
      dbProvider: null,
      dbRegion: null,
      dbOrg: null,
    };
  }

  // Asked after the target, because it is the target that would provide one by default. The three
  // answers are the three shapes `deploy.database` takes — see DeploySchema.
  const deployDatabase = await select({
    message: "Where should your production data live?",
    options: [
      {
        value: "managed",
        label: `Alongside the app, on ${targets[targetId].label}`,
        hint: "the target provides it",
      },
      ...(guided
        ? Object.values(dbHosts).map((host) => ({
            value: host.id,
            label: `On a new ${host.label} project`,
            hint: `warehousd runs \`${host.cli.bin} projects create\` for you`,
          }))
        : []),
      { value: "external", label: "On a Postgres I already run", hint: "you supply the url" },
    ],
    initialValue: defaults.deployManaged ? "managed" : (defaults.dbProvider ?? "external"),
  });
  if (isCancel(deployDatabase)) return null;

  // `provider` means one of two things depending on which branch we are in, so both are resolved
  // here rather than left for the caller to infer.
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
      message: `Which region for the ${provisioningHost.label} database?`,
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
        message: "Supabase organisation id",
        placeholder: "leave blank if you only have one",
        defaultValue: "",
      });
      if (isCancel(org)) return null;
      dbOrg = String(org) || null;
    }
  } else if (!deployManaged) {
    // Attaching one you already run: `provider` is the override it has always been, and only
    // matters where the hostname does not say who hosts it.
    const provider = await select({
      message: "Who hosts that Postgres?",
      options: Object.values(dbProviders).map((p) => ({ value: p.id, label: p.label })),
      initialValue: String(defaults.dbProvider ?? "generic"),
    });
    if (isCancel(provider)) return null;
    dbProvider = idIn(provider, dbProviders, "generic");
  }

  return { ...answers, target: targetId, deployManaged, dbProvider, dbRegion, dbOrg };
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
