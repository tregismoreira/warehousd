import { resolveProject } from "./project";
import { tryRun, removeVolume, removeNetwork } from "./docker";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/require-await -- keeps the runX signatures uniform
export async function runStop(
  dir: string,
  opts: { destroy?: boolean; yes?: boolean } = {},
): Promise<void> {
  const p = resolveProject(dir);

  // Remove containers by label
  const listResult = tryRun(["ps", "-aq", "--filter", `label=${p.ns.label}`]);
  if (listResult.ok && listResult.out) {
    const containerIds = listResult.out.split("\n").filter((id) => id.trim());
    for (const id of containerIds) {
      tryRun(["rm", "-f", id]);
    }
  }

  if (opts.destroy) {
    // Require confirmation for destructive action
    if (!opts.yes) {
      console.log(`about to remove volume ${p.ns.volume} (all data)`);
      // In a real CLI, this would be interactive. For now, throw if not --yes.
      throw new Error("Pass --yes to confirm destruction");
    }

    removeVolume(p.ns.volume);
    removeNetwork(p.ns.net);

    // Delete outputs.json but keep state.json
    const outputsPath = join(dir, ".warehousd", "outputs.json");
    try {
      unlinkSync(outputsPath);
    } catch (err: unknown) {
      // Ignore if file doesn't exist
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
}
