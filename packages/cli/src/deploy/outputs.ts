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
 * `target` has no default on purpose. The summary names where the deployment went and how to reach
 * a database it did not print a URL for, and the only honest source for both is the target that
 * just ran — a fallback here would be the Fly wording it replaced, quietly wrong everywhere else.
 */
export function formatDeployOutputs(
  o: DeployOutputs,
  extra: { adminEmail: string; adminPassword: string },
  target: { label: string; databaseHint: string; notes?: string[] | undefined },
  opts?: { theme?: Theme | undefined; showSecrets?: boolean | undefined },
): string {
  return renderDeploySummary({
    outputs: o,
    target,
    admin: { email: extra.adminEmail, password: extra.adminPassword },
    theme: opts?.theme ?? plainTheme,
    showSecrets: opts?.showSecrets ?? false,
  });
}
