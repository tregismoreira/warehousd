import { execFileSync } from "node:child_process";
import { checkTool, type CliTool, type PreflightCheck, type ToolProbe } from "./cli-tools";
import { traceCommand, traceFailure } from "./verbose";

export class FlyError extends Error {}

/**
 * flyctl, as cli-tools.ts wants it described.
 *
 * `version` rather than `--version`: flyctl accepts both, and the subcommand form works on the
 * older builds people have lying around. There is no npm route — Fly ships a shell installer,
 * which is what `docsUrl` is for on a machine with no brew.
 */
export const flyTool: CliTool = {
  bin: "flyctl",
  label: "flyctl",
  versionArgs: ["version"],
  readyArgs: ["auth", "whoami"],
  readyHint: "Not authenticated with flyctl. Run: flyctl auth login",
  docsUrl: "https://fly.io/docs/flyctl/install/",
  installers: [{ manager: "brew", args: ["install", "flyctl"] }],
  manualInstall: "curl -L https://fly.io/install.sh | sh",
};

/** Present and logged in? The pre-flight form — never throws. */
export function checkFly(probe?: ToolProbe): PreflightCheck {
  return checkTool(flyTool, probe);
}

// Same reasoning as packages/cli/src/docker.ts: `execFileSync` echoes the child's stderr to the
// parent unless `stdio` says otherwise, so `tryRun`'s probes — `appExists` calls `status`, which
// fails loudly for an app that does not exist yet — narrated their own negative answers at the
// user. Capturing also populates `err.stderr`, which is what FlyError wants to carry.
// stdin stays "pipe" rather than "ignore" on purpose: `execFileSync` silently *drops* the `input`
// option when stdio[0] is "ignore", and `deploy.ts` pipes every Fly secret in through `input`
// (`secrets import --stage`). "ignore" there would stage an app with no secrets at all and report
// success.
const CAPTURED: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

// `deploy` and `launch` stream build logs that the operator genuinely needs to watch.
const INHERIT_STDERR: ["pipe", "pipe", "inherit"] = ["pipe", "pipe", "inherit"];

const STREAMING = new Set(["deploy", "launch"]);

/** The throwing form, for the code paths that cannot carry on without flyctl. */
export function assertFly(probe?: ToolProbe): void {
  const check = checkFly(probe);
  if (!check.ok) throw new FlyError(check.detail);
}

export function run(args: string[], opts?: { input?: string | undefined }): string {
  const stream = args[0] !== undefined && STREAMING.has(args[0]);
  const isSecrets = args[0] === "secrets";
  // argv is safe to echo even here: secret material travels on stdin precisely so it never
  // appears in a command line. The stderr below is not safe, and is handled separately.
  traceCommand("flyctl", args);
  try {
    const output = execFileSync("flyctl", args, {
      encoding: "utf8",
      input: opts?.input,
      stdio: stream ? INHERIT_STDERR : CAPTURED,
    });
    return output.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    if (isSecrets) {
      // flyctl echoes the offending assignment when a secret fails to set, so this stderr can
      // contain the credential itself. It is redacted out of the thrown error, and --verbose must
      // not be a way around that: a debug flag that prints secrets is a secret-printing flag.
      throw new FlyError("Failed to manage secrets");
    }
    traceFailure((error.stderr || error.message || "").trim());
    throw new FlyError(error.stderr || error.message);
  }
}

export function tryRun(args: string[]): { ok: boolean; out: string } {
  try {
    const out = run(args);
    return { ok: true, out };
  } catch {
    return { ok: false, out: "" };
  }
}

export function appExists(app: string): boolean {
  const result = tryRun(["status", "--app", app]);
  return result.ok;
}
