import { confirm as clackConfirm, text, select, isCancel, cancel } from "@clack/prompts";

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

export type InitAnswers = { project: string; port: number; managed: boolean };

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

  return {
    project: String(project) || defaults.project,
    port: Number(port) || defaults.port,
    managed: database === "managed",
  };
}
