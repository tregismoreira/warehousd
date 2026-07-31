import type { WarehousdConfig } from "@warehousd/broker";
import type { DeployOutputs } from "../state";

export function buildDeployOutputs(args: {
  appName: string;
  cfg: WarehousdConfig;
  databaseUrl: string | null;
  now: Date;
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
  };
}

export function formatDeployOutputs(
  o: DeployOutputs,
  extra: { adminEmail: string; adminPassword: string },
): string {
  const lines: string[] = [
    "═══════════════════════════════════════════════════════════",
    "warehousd deployed to Fly",
    "═══════════════════════════════════════════════════════════",
    "",
    "MCP Server:",
    `  ${o.mcpUrl}`,
    "",
    "API Server:",
    `  ${o.apiUrl}`,
    "",
    "Admin UI:",
    `  ${o.adminUrl}`,
    "",
  ];

  if (o.databaseUrl) {
    lines.push("Database:");
    lines.push(`  ${o.databaseUrl}`);
  } else {
    lines.push("Database:");
    lines.push("  Managed by Fly Postgres; use `fly postgres connect` to access it");
  }

  lines.push("");
  lines.push("Environment:");
  lines.push(`  ${o.env}`);
  lines.push("");
  lines.push("Admin Login:");
  lines.push(`  Email:    ${extra.adminEmail}`);
  lines.push(`  Password: ${extra.adminPassword}`);
  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════");

  return lines.join("\n");
}
