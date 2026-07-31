import { loadConfig } from "@warehousd/broker";
import { IMAGE_REPO } from "./image";

// WAREHOUSD_CLI_VERSION is defined by tsup at build time; fallback to 'latest' in dev mode.
declare const WAREHOUSD_CLI_VERSION: string | undefined;

export type ImageSource = "server.image" | "WAREHOUSD_IMAGE" | "default";
export type ResolvedImage = { ref: string; source: ImageSource };

export function cliVersion(): string {
  return typeof WAREHOUSD_CLI_VERSION !== "undefined" ? WAREHOUSD_CLI_VERSION : "latest";
}

/**
 * Which image `start` will run, and — the part that mattered — *why* that one.
 *
 * The precedence itself is not new; `start.ts` already had it inline. What was missing was any way
 * to ask the question without also performing the pull, so a user whose image could not be fetched
 * learned the tag from a registry error rather than from us. `doctor` and `start`'s preflight both
 * call this before anything is created.
 */
export function resolveServerImage(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedImage {
  const cfg = loadConfig(projectDir);
  const fromConfig = cfg.server.image;
  if (fromConfig) return { ref: fromConfig, source: "server.image" };
  if (env.WAREHOUSD_IMAGE) return { ref: env.WAREHOUSD_IMAGE, source: "WAREHOUSD_IMAGE" };
  return { ref: `${IMAGE_REPO}:${cliVersion()}`, source: "default" };
}
