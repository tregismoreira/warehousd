import { spawn } from "node:child_process";
import { readOutputs } from "./../state";
import { useProject } from "./../project";
import { containerState } from "./../docker";

export type Target = "admin" | "mcp" | "api";

export function resolveUrl(dir: string, target: Target = "admin"): string {
  const outputs = readOutputs(dir);
  if (!outputs) {
    throw new Error("Nothing to open — no .warehousd/outputs.json. Run `warehousd start` first.");
  }
  // A plain `stop` leaves outputs.json behind — only `--destroy` removes it (stop.ts) — so the
  // file existing is not evidence that anything is listening. Without this check `open` launched a
  // browser at a dead port and said nothing.
  const state = containerState(useProject(dir).ns.server);
  if (state !== "running") {
    throw new Error(
      `The server container is ${state === "absent" ? "not there" : state}. Run \`warehousd start\` first.`,
    );
  }
  if (target === "mcp") return outputs.mcpUrl;
  if (target === "api") return outputs.apiUrl;
  return outputs.adminUrl;
}

/** The opener for the current platform, or null where we should just print the URL. */
export function openerFor(platform: NodeJS.Platform): { cmd: string; args: string[] } | null {
  if (platform === "darwin") return { cmd: "open", args: [] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", ""] };
  if (platform === "linux") return { cmd: "xdg-open", args: [] };
  return null;
}

export function runOpen(
  dir: string,
  target: Target = "admin",
  platform: NodeJS.Platform = process.platform,
): { url: string; opened: boolean } {
  const url = resolveUrl(dir, target);
  const opener = openerFor(platform);
  if (!opener) return { url, opened: false };

  // Detached and unref'd: the browser outliving this process is the point, and a CLI that waits
  // for a GUI to exit would hang.
  const child = spawn(opener.cmd, [...opener.args, url], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return { url, opened: true };
}
