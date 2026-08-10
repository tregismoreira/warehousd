import { spawn } from "node:child_process";
import { useProject } from "./../project";
import { containerState, logs as dockerLogs } from "./../docker";

export type LogsOptions = {
  follow?: boolean | undefined;
  tail?: number | undefined;
  service?: "server" | "db" | undefined;
};

/**
 * `docker logs wh_<project>_server` was the answer to most "it started but nothing works"
 * questions, and the troubleshooting section of docs/cli.md said so. A command that already knows
 * the container name should not make anyone assemble it.
 */
export function resolveLogTarget(dir: string, service: "server" | "db" = "server"): string {
  const p = useProject(dir);
  if (service === "db") {
    if (!p.managed) {
      throw new Error(
        "This project uses `database.url`, so there is no database container to read logs from.",
      );
    }
    return p.ns.db;
  }
  return p.ns.server;
}

export async function runLogs(dir: string, opts: LogsOptions = {}): Promise<string | null> {
  const target = resolveLogTarget(dir, opts.service ?? "server");

  if (containerState(target) === "absent") {
    throw new Error(`No container ${target}. Run \`warehousd start\` first.`);
  }

  if (!opts.follow) {
    return dockerLogs(target, opts.tail);
  }

  // `--follow` never returns on its own, so it cannot go through execFileSync. Inheriting the
  // streams hands Docker's output straight to the terminal, and Ctrl-C reaches the child.
  await new Promise<void>((resolve, reject) => {
    const args = ["logs", "--follow"];
    if (opts.tail) args.push("--tail", String(opts.tail));
    args.push(target);
    const child = spawn("docker", args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    // A non-zero code here is almost always the user pressing Ctrl-C, which is not a failure.
    child.on("close", () => resolve());
  });
  return null;
}
