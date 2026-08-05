import type { WarehousdConfig } from "@warehousd/broker";
import type { DeployOutputs } from "../state";
import type { Theme } from "../ui/theme";
import { plainTheme } from "../ui/theme";
import { renderDeploySummary } from "../ui/render";

/**
 * `baseUrl` comes from the target (`DeployTarget.appUrl`), not from the app name. It used to be
 * built here as `https://${appName}.fly.dev`, which made this shared module know where Fly puts
 * things and left no way to record a Railway domain or a Compose port.
 */
export function buildDeployOutputs(args: {
  baseUrl: string;
  cfg: WarehousdConfig;
  databaseUrl: string | null;
  now: Date;
  migrationVersions?: string[];
}): DeployOutputs {
  const base = args.baseUrl;
  return {
    mcpUrl: `${base}/mcp`,
    apiUrl: base,
    adminUrl: `${base}/admin`,
    databaseUrl: args.databaseUrl,
    env: "dev",
    deployedAt: args.now.toISOString(),
    configSnapshot: args.cfg,
    migrationVersions: args.migrationVersions ?? [],
  };
}

/**
 * `target` is what the panel cannot get from `DeployOutputs`: the name to print in the title and
 * the command to offer when the target manages the database itself. Both used to be Fly literals
 * in the renderer.
 */
export function formatDeployOutputs(
  o: DeployOutputs,
  extra: {
    adminEmail: string;
    adminPassword: string;
    target: { label: string; databaseHint: string };
  },
  opts?: { theme?: Theme | undefined; showSecrets?: boolean | undefined },
): string {
  return renderDeploySummary({
    outputs: o,
    admin: { email: extra.adminEmail, password: extra.adminPassword },
    target: extra.target,
    theme: opts?.theme ?? plainTheme,
    showSecrets: opts?.showSecrets ?? false,
  });
}
