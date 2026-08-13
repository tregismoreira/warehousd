import { TOOLS } from "../mcp-tools";

// The exact tools/list payload the /mcp endpoint answers with — see mcp-manifest.test.ts, which
// drives a real tools/list call through the route handler and asserts this equals it.
export function buildMcpManifest(): {
  tools: { name: string; description: string; inputSchema: unknown }[];
} {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}
