import { execFileSync } from "node:child_process";
import { checkTool, type CliTool, type PreflightCheck, type ToolProbe } from "./cli-tools";
import { traceCommand, traceFailure } from "./verbose";

export class NeonError extends Error {}

/**
 * The Neon CLI, whose binary is `neon` and whose npm package is `neonctl`.
 *
 * `me` is the auth probe: it is a read, and it fails cleanly when nobody is logged in.
 */
export const neonTool: CliTool = {
  bin: "neon",
  label: "Neon CLI",
  versionArgs: ["--version"],
  readyArgs: ["me"],
  readyHint: "Not authenticated with the Neon CLI. Run: neon auth",
  docsUrl: "https://neon.com/docs/reference/neon-cli",
  installers: [
    { manager: "npm", args: ["i", "-g", "neonctl"] },
    { manager: "brew", args: ["install", "neonctl"] },
  ],
};

export function checkNeon(probe?: ToolProbe): PreflightCheck {
  return checkTool(neonTool, probe);
}

export function assertNeon(probe?: ToolProbe): void {
  const check = checkNeon(probe);
  if (!check.ok) throw new NeonError(check.detail);
}

// See the identical note in fly.ts, railway.ts, docker.ts and supabase.ts.
const CAPTURED: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

/**
 * Nothing here carries a secret in argv — which is the whole reason Neon is the easy one. The
 * credential travels the other way: `projects create --output json` prints a connection URI with
 * the password in it on **stdout**, which is why `run` returns output the caller consumes and
 * `traceFailure` only ever echoes stderr. A trace that printed stdout would print the database
 * password, so do not add one.
 */
export function run(args: string[]): string {
  traceCommand("neon", args);
  try {
    const output = execFileSync("neon", args, { encoding: "utf8", stdio: CAPTURED });
    return (output ?? "").trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    traceFailure((error.stderr || error.message || "").trim());
    throw new NeonError(error.stderr || error.message);
  }
}

export function tryRun(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(args) };
  } catch {
    return { ok: false, out: "" };
  }
}

/**
 * The owner connection URI out of a `projects create --output json` body.
 *
 * Three shapes, because the CLI's exact output has moved across versions and a deploy must not
 * break on a field being nested one level differently. `connection_uris[0].connection_uri` is the
 * documented one; the other two are what older and newer builds have printed. A body none of them
 * matches is reported as such — "Neon created the project but warehousd could not read its
 * connection string" leads somewhere, where a crash on `undefined` does not.
 */
export function connectionUri(out: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const body = parsed as {
    connection_uris?: unknown;
    connection_uri?: unknown;
    project?: { connection_uris?: unknown };
  };

  if (typeof body.connection_uri === "string" && body.connection_uri) return body.connection_uri;

  for (const candidate of [body.connection_uris, body.project?.connection_uris]) {
    const first = Array.isArray(candidate) ? candidate[0] : undefined;
    if (typeof first === "string" && first) return first;
    if (typeof first === "object" && first !== null) {
      const uri = (first as { connection_uri?: unknown }).connection_uri;
      if (typeof uri === "string" && uri) return uri;
    }
  }
  return undefined;
}

/** The created project's id, read off the same body. */
export function projectId(out: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const body = parsed as { id?: unknown; project?: { id?: unknown } };
  if (typeof body.id === "string") return body.id;
  if (typeof body.project?.id === "string") return body.project.id;
  return undefined;
}
