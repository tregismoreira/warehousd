import type { WarehousdConfig } from "@warehousd/broker";
import type { DeployOutputs } from "../state";
import type { Theme } from "../ui/theme";
import { plainTheme } from "../ui/theme";
import { renderDeploySummary } from "../ui/render";

export function buildDeployOutputs(args: {
  appName: string;
  cfg: WarehousdConfig;
  databaseUrl: string | null;
  now: Date;
  migrationVersions?: string[];
}): DeployOutputs {
  const base = `https://${args.appName}.fly.dev`;
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

export function formatDeployOutputs(
  o: DeployOutputs,
  extra: { adminEmail: string; adminPassword: string },
  opts?: { theme?: Theme | undefined; showSecrets?: boolean | undefined },
): string {
  return renderDeploySummary({
    outputs: o,
    admin: { email: extra.adminEmail, password: extra.adminPassword },
    theme: opts?.theme ?? plainTheme,
    showSecrets: opts?.showSecrets ?? false,
  });
}
