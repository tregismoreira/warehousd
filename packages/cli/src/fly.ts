import { execFileSync } from "node:child_process";

export class FlyError extends Error {}

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

export function assertFly(): void {
  try {
    execFileSync("flyctl", ["version"], { encoding: "utf8", stdio: CAPTURED });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new FlyError(
        "flyctl not found on PATH. Install with one of: brew install flyctl, curl -L https://fly.io/install.sh | sh, or see https://fly.io/docs/flyctl/install/",
      );
    }
  }

  try {
    execFileSync("flyctl", ["auth", "whoami"], { encoding: "utf8", stdio: CAPTURED });
  } catch {
    throw new FlyError("Not authenticated with flyctl. Run: flyctl auth login");
  }
}

export function run(args: string[], opts?: { input?: string | undefined }): string {
  const stream = args[0] !== undefined && STREAMING.has(args[0]);
  try {
    const output = execFileSync("flyctl", args, {
      encoding: "utf8",
      input: opts?.input,
      stdio: stream ? INHERIT_STDERR : CAPTURED,
    });
    return output.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    if (args[0] === "secrets") {
      throw new FlyError("Failed to manage secrets");
    }
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
