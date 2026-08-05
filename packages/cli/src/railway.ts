import { execFileSync } from "node:child_process";
import { traceCommand, traceFailure } from "./verbose";

export class RailwayError extends Error {}

// Same reasoning as fly.ts and docker.ts: `execFileSync` echoes the child's stderr to the parent
// unless `stdio` says otherwise, so every probe here — "is a project linked?", "does this service
// exist?" — would narrate its own negative answer at the user. Capturing also populates
// `err.stderr`, which is what RailwayError wants to carry.
//
// stdin stays "pipe" rather than "ignore" because a Railway subcommand that finds itself without an
// answer prompts for one; a closed stdin turns that into an immediate failure with a message,
// which is the right outcome for a non-interactive deploy. "ignore" would leave it waiting.
const CAPTURED: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

// `up` streams the build log the operator needs to watch, exactly as `flyctl deploy` does.
const STREAMING = new Set(["up"]);

/**
 * Does this invocation carry secret material in argv?
 *
 * Railway has no `secrets import --stage` equivalent — `railway variables --set K=V` is the only
 * way to set one, and the value travels in argv. That cannot be fixed here, so it is contained
 * here: the trace never echoes these args, and a failure never carries this command's stderr.
 * docs/deploy-railway.md states the residual exposure, which is the process table on the machine
 * running the deploy.
 *
 * Keyed on `--set` rather than on the subcommand, so a read (`variables --json`) keeps the real
 * error — there is nothing to redact in it, and "failed to set variables" would be a lie.
 */
function carriesSecrets(args: string[]): boolean {
  return args[0] === "variables" && args.includes("--set");
}

/** argv with every `--set` value replaced, for a trace that must not print a credential. */
function redact(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    out.push(arg);
    if (arg === "--set" && i + 1 < args.length) {
      // The name is worth keeping — knowing *which* variable failed is the whole value of the
      // trace — and it is not the half that is secret.
      const [name] = args[++i]!.split("=", 1);
      out.push(`${name}=***`);
    }
  }
  return out;
}

export function assertRailway(): void {
  try {
    execFileSync("railway", ["--version"], { encoding: "utf8", stdio: CAPTURED });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new RailwayError(
        "railway not found on PATH. Install with one of: npm i -g @railway/cli, brew install railway, or see https://docs.railway.com/guides/cli",
      );
    }
  }

  try {
    execFileSync("railway", ["whoami"], { encoding: "utf8", stdio: CAPTURED });
  } catch {
    throw new RailwayError(
      "Not authenticated with railway. Run: railway login, or set RAILWAY_TOKEN in the environment.",
    );
  }
}

/**
 * Every Railway subcommand acts on the *linked* project, which is a file in the working directory
 * rather than a flag — hence `cwd`. It is the project directory throughout, so a deploy links the
 * operator's project once and every later command finds it.
 */
export function run(args: string[], opts: { cwd: string }): string {
  const stream = args[0] !== undefined && STREAMING.has(args[0]);
  const secretBearing = carriesSecrets(args);
  traceCommand("railway", secretBearing ? redact(args) : args);
  try {
    const output = execFileSync("railway", args, {
      encoding: "utf8",
      cwd: opts.cwd,
      stdio: stream ? ["pipe", "inherit", "inherit"] : CAPTURED,
    });
    // `up` inherits stdout so the build log reaches the terminal, which leaves nothing to return.
    return (output ?? "").trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    if (secretBearing) {
      // Railway echoes the assignment it could not apply, so this stderr can contain the value
      // itself. It is redacted out of the thrown error, and --verbose must not be a way around
      // that: a debug flag that prints secrets is a secret-printing flag.
      throw new RailwayError("Failed to set Railway variables");
    }
    traceFailure((error.stderr || error.message || "").trim());
    throw new RailwayError(error.stderr || error.message);
  }
}

export function tryRun(args: string[], opts: { cwd: string }): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(args, opts) };
  } catch {
    return { ok: false, out: "" };
  }
}

/**
 * The linked project, or null when this directory is linked to nothing.
 *
 * `railway status --json` is the only non-mutating way to ask, and its exact shape has changed
 * across CLI versions — so this reads the two fields it needs and tolerates the rest being
 * different from what it expects. A shape it cannot read is reported as "no services", never as a
 * crash: the caller's response to that is to create one, which is idempotent anyway.
 */
export function linkedProject(cwd: string): { name: string; services: string[] } | null {
  const status = tryRun(["status", "--json"], { cwd });
  if (!status.ok || status.out === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(status.out);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const project = parsed as { name?: unknown; services?: { edges?: unknown } };
  const edges = Array.isArray(project.services?.edges) ? project.services.edges : [];
  const services = edges
    .map((edge) => (edge as { node?: { name?: unknown } } | null)?.node?.name)
    .filter((name): name is string => typeof name === "string");

  return { name: typeof project.name === "string" ? project.name : "", services };
}
