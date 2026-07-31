import { execFileSync } from "node:child_process";

export class FlyError extends Error {}

export function assertFly(): void {
  try {
    execFileSync("flyctl", ["version"], { encoding: "utf8" });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new FlyError(
        "flyctl not found on PATH. Install with one of: brew install flyctl, curl -L https://fly.io/install.sh | sh, or see https://fly.io/docs/flyctl/install/",
      );
    }
  }

  try {
    execFileSync("flyctl", ["auth", "whoami"], { encoding: "utf8" });
  } catch {
    throw new FlyError("Not authenticated with flyctl. Run: flyctl auth login");
  }
}

export function run(args: string[], opts?: { input?: string | undefined }): string {
  try {
    const output = execFileSync("flyctl", args, {
      encoding: "utf8",
      input: opts?.input,
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
