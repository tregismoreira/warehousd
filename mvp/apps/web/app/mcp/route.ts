import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { deriveTokenContext } from "../../lib/broker-context";
import { TOOLS, toolByName } from "../../lib/mcp-tools";

// Stateless streamable HTTP: a fresh Server + transport per request. A Server can only be
// connect()ed to one transport at a time, so a shared module-level instance would race under
// concurrent requests — this is the SDK's documented pattern for stateless deployments.
async function handle(req: Request): Promise<Response> {
  const ctx = await deriveTokenContext(req);
  if (!ctx) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const server = new Server({ name: "warehousd", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const toolName = req.params?.name ?? req.name;
    const toolArgs = req.params?.arguments ?? req.arguments ?? {};
    const tool = toolByName(toolName);
    if (!tool) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "unknown_tool" }) }], isError: true };
    }
    try {
      const out = await tool.handler(ctx, toolArgs);
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    } catch (error) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "tool_error", message: String(error) }) }], isError: true };
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function POST(req: Request) { return handle(req); }
export async function GET(req: Request) { return handle(req); }
export async function DELETE(req: Request) { return handle(req); }
