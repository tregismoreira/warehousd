import type { Project } from "./project";
import type { Outputs } from "./state";

export function buildOutputs(
  p: Project,
  dbUrl: string,
  devClient: { clientId: string; clientSecret: string }
): Outputs {
  return {
    mcpUrl: `http://localhost:${p.ports.server}/mcp`,
    apiUrl: `http://localhost:${p.ports.server}`,
    adminUrl: `http://localhost:${p.ports.server}/admin`,
    databaseUrl: dbUrl,
    env: "dev",
    devClient,
  };
}

export function formatOutputs(
  o: Outputs,
  extra?: { adminEmail: string; adminPassword: string }
): string {
  const lines: string[] = [
    "═══════════════════════════════════════════════════════════",
    "warehousd is running",
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
    "Database:",
    `  ${o.databaseUrl}`,
    "",
    "Environment:",
    `  ${o.env}`,
    "",
    "Dev Client:",
    `  ID:     ${o.devClient.clientId}`,
    `  Secret: ${o.devClient.clientSecret}`,
  ];

  if (extra) {
    lines.push("");
    lines.push("Admin Login:");
    lines.push(`  Email:    ${extra.adminEmail}`);
    lines.push(`  Password: ${extra.adminPassword}`);
  }

  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════");

  return lines.join("\n");
}
