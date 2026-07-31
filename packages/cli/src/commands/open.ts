import { spawn } from "node:child_process";
import { readOutputs } from "./../state";

export type Target = "admin" | "mcp" | "api";

export function resolveUrl(dir: string, target: Target = "admin"): string {
  const outputs = readOutputs(dir);
  if (!outputs) {
    throw new Error("Nothing to open — no .warehousd/outputs.json. Run `warehousd start` first.");
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
