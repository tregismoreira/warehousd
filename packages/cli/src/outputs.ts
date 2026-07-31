import type { Project } from "./project";
import type { Outputs } from "./state";
import type { Theme } from "./ui/theme";
import { plainTheme } from "./ui/theme";
import { renderStartSummary } from "./ui/render";

export function buildOutputs(
  p: Project,
  dbUrl: string,
  devClient: { clientId: string; clientSecret: string },
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
  extra?: { adminEmail: string; adminPassword: string },
  opts?: {
    theme?: Theme | undefined;
    showSecrets?: boolean | undefined;
    elapsed?: string | undefined;
  },
): string {
  return renderStartSummary({
    outputs: o,
    ...(extra ? { admin: { email: extra.adminEmail, password: extra.adminPassword } } : {}),
    theme: opts?.theme ?? plainTheme,
    showSecrets: opts?.showSecrets ?? false,
    elapsed: opts?.elapsed,
  });
}
