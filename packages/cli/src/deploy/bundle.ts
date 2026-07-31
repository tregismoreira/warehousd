import { cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type WarehousdConfig } from "@warehousd/broker";

/**
 * Collects paths to include in the deploy image: warehousd.yml plus every collection's source
 * directory (but never source_live, and never warehousd.local.yml). This is a security invariant:
 * live documents must not leave the operator's machine, and the deployed instance must never be
 * able to populate data_live.
 *
 * Returns paths relative to the project directory, in stable sorted order so the Docker layer is reproducible.
 * Deduplicates (several collections may share a source directory).
 */
export function collectBundlePaths(cfg: WarehousdConfig): string[] {
  const paths = new Set<string>();

  // Always include warehousd.yml
  paths.add("warehousd.yml");

  // Add all collection source directories (not source_live)
  for (const collection of Object.values(cfg.collections)) {
    if (collection.source) {
      paths.add(collection.source);
    }
  }

  // Convert to sorted array for reproducibility
  return Array.from(paths).sort();
}

/**
 * Copies the bundle paths into outDir (.warehousd/deploy/context/), preserving relative
 * structure and creating directories as needed. Clears outDir first so removed collections'
 * docs do not linger from a previous deploy.
 */
export function writeBundle(cfg: WarehousdConfig, projectDir: string, outDir: string): void {
  const paths = collectBundlePaths(cfg);

  // Clear outDir if it exists
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  // Copy each path
  for (const path of paths) {
    const src = join(projectDir, path);
    const dst = join(outDir, path);

    // Ensure parent directory exists
    const dstDir = dst.includes("/") ? dst.substring(0, dst.lastIndexOf("/")) : outDir;
    mkdirSync(dstDir, { recursive: true });

    // Copy with cpSync (handles both files and directories)
    cpSync(src, dst, { recursive: true });
  }
}
