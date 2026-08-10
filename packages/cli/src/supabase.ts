import { execFileSync } from "node:child_process";
import { checkTool, type CliTool, type PreflightCheck, type ToolProbe } from "./cli-tools";
import { traceCommand, traceFailure } from "./verbose";

export class SupabaseError extends Error {}

/**
 * The Supabase CLI.
 *
 * `projects list` rather than a `whoami`: there is no dedicated auth probe, and listing projects
 * is the cheapest command that fails when nobody is logged in. It is a read, so running it as a
 * readiness check mutates nothing.
 */
export const supabaseTool: CliTool = {
  bin: "supabase",
  label: "Supabase CLI",
  versionArgs: ["--version"],
  readyArgs: ["projects", "list"],
  readyHint: "Not authenticated with the Supabase CLI. Run: supabase login",
  docsUrl: "https://supabase.com/docs/guides/local-development/cli/getting-started",
  installers: [
    { manager: "brew", args: ["install", "supabase/tap/supabase"] },
    { manager: "npm", args: ["i", "-g", "supabase"] },
    { manager: "scoop", args: ["install", "supabase"] },
  ],
};

export function checkSupabase(probe?: ToolProbe): PreflightCheck {
  return checkTool(supabaseTool, probe);
}

export function assertSupabase(probe?: ToolProbe): void {
  const check = checkSupabase(probe);
  if (!check.ok) throw new SupabaseError(check.detail);
}

// Same reasoning as fly.ts, railway.ts and docker.ts: `execFileSync` echoes the child's stderr to
// the parent unless `stdio` says otherwise, so every probe here would narrate its own negative
// answer. Capturing also populates `err.stderr`, which is what SupabaseError wants to carry.
//
// stdin stays "pipe" rather than "ignore": a Supabase subcommand missing an answer prompts for
// one, and a closed stdin turns that into an immediate failure with a message — the right outcome
// for a non-interactive deploy. "ignore" would leave it waiting forever.
const CAPTURED: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

// `start` pulls and boots a dozen containers and takes minutes; its progress is the only thing
// telling the operator it has not hung.
const STREAMING = new Set(["start"]);

/**
 * Does this invocation carry secret material in argv?
 *
 * `projects create --db-password <pw>` is the only way to set the database password, and there is
 * no stdin alternative. That cannot be fixed here, so it is contained here — exactly as
 * railway.ts contains `variables --set`: the trace never echoes the value, and a failure never
 * carries this command's stderr, because Supabase echoes back what it could not accept.
 *
 * The residual exposure is the process table on the machine running the deploy; docs/deploy-database.md
 * says so rather than leaving it implied.
 */
function carriesSecrets(args: string[]): boolean {
  return args.includes("--db-password");
}

/** argv with the password replaced, for a trace that must not print a credential. */
function redact(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    // The flag itself is worth keeping — knowing which command failed is the value of the trace —
    // and it is not the half that is secret.
    out.push(out[out.length - 1] === "--db-password" ? "***" : arg);
  }
  return out;
}

export function run(args: string[], opts?: { cwd?: string }): string {
  const stream = args[0] !== undefined && STREAMING.has(args[0]);
  const secretBearing = carriesSecrets(args);
  traceCommand("supabase", secretBearing ? redact(args) : args);
  try {
    const output = execFileSync("supabase", args, {
      encoding: "utf8",
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      stdio: stream ? ["pipe", "inherit", "inherit"] : CAPTURED,
    });
    return (output ?? "").trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    if (secretBearing) {
      // `--verbose` must not be a way around the redaction above: a debug flag that prints secrets
      // is a secret-printing flag.
      throw new SupabaseError("Failed to create the Supabase project");
    }
    traceFailure((error.stderr || error.message || "").trim());
    throw new SupabaseError(error.stderr || error.message);
  }
}

export function tryRun(args: string[], opts?: { cwd?: string }): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(args, opts) };
  } catch {
    return { ok: false, out: "" };
  }
}

/**
 * The organisations this account can create projects in.
 *
 * `--output json` is the contract, and the shape has changed across CLI versions — so this reads
 * the two fields it needs and tolerates the rest being different, the same way railway.ts's
 * `linkedProject` does. An unreadable answer is an empty list, which the caller reports as "name
 * an org" rather than crashing on.
 */
export function organisations(): { id: string; name: string }[] {
  const result = tryRun(["orgs", "list", "--output", "json"]);
  if (!result.ok || result.out === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.out);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const org = entry as { id?: unknown; name?: unknown };
    if (typeof org.id !== "string") return [];
    return [{ id: org.id, name: typeof org.name === "string" ? org.name : org.id }];
  });
}
