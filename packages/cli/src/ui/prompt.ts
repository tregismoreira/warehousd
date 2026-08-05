import { confirm as clackConfirm, text, select, isCancel, cancel } from "@clack/prompts";
import { dbProviders, type DbProviderId, type DeployTargetId } from "@warehousd/broker";
import { targets } from "../deploy/targets";

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
 * `dbProvider` is null exactly when `managed` is true: under `managed` the target provisions the
 * database and knows what it built, and `DeploySchema` refuses a `provider` with no `url` for that
 * reason — it would name where a database that does not exist here is hosted.
 */
export type InitAnswers = {
  project: string;
  port: number;
  managed: boolean;
  target: DeployTargetId;
  dbProvider: DbProviderId | null;
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

  const database = await select({
    message: "Database",
    options: [
      { value: "managed", label: "Let warehousd run Postgres in Docker", hint: "recommended" },
      { value: "external", label: "Bring my own, via database.url" },
    ],
    initialValue: defaults.managed ? "managed" : "external",
  });
  if (isCancel(database)) return null;
  const managed = database === "managed";

  const target = await select({
    message: "Deploy target",
    options: optionsFrom(targets),
    initialValue: String(defaults.target),
  });
  if (isCancel(target)) return null;

  // Only alongside a url. Under `managed` the target provisions the database, and naming a
  // provider for it would be a key that decided nothing while reading as though it did.
  let dbProvider: DbProviderId | null = null;
  if (!managed) {
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
    target: idIn(target, targets, defaults.target),
    dbProvider,
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
