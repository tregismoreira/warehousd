import { resolveProject } from "./project";
import { hostFor } from "./db/hosts";
import { tryRun, removeVolume, removeNetwork } from "./docker";
import { confirm, isInteractive } from "./ui/prompt";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

export async function runStop(
  dir: string,
  opts: { destroy?: boolean; yes?: boolean; interactive?: boolean } = {},
): Promise<void> {
  const p = resolveProject(dir);

  // A provider's local stack is not labelled as ours and is not on our network, so the sweep
  // below will not touch it — it has to be stopped through its own CLI. Anything warehousd
  // started, warehousd stops.
  const localDbHost = p.cfg.database?.provider ? hostFor(p.cfg.database.provider) : undefined;
  if (localDbHost?.local) {
    await localDbHost.local.stop({ projectDir: p.dir, say: () => {} });
  }

  // Remove containers by label
  const listResult = tryRun(["ps", "-aq", "--filter", `label=${p.ns.label}`]);
  if (listResult.ok && listResult.out) {
    const containerIds = listResult.out.split("\n").filter((id) => id.trim());
    for (const id of containerIds) {
      tryRun(["rm", "-f", id]);
    }
  }

  if (opts.destroy) {
    // Destroying a volume is irreversible, so it is confirmed rather than assumed. Interactively
    // that is a prompt; piped or in CI there is nobody to ask, so --yes stays mandatory there.
    if (!opts.yes) {
      const confirmed = await confirm({
        message: `Remove volume ${p.ns.volume} and every document in it? This cannot be undone.`,
        flag: "--yes",
        interactive: opts.interactive ?? isInteractive(),
      });
      if (!confirmed) return;
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
