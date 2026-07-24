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

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolByName(req.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "unknown_tool" }) }], isError: true };
    }
    const out = await tool.handler(ctx, req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function POST(req: Request) { return handle(req); }
export async function GET(req: Request) { return handle(req); }
export async function DELETE(req: Request) { return handle(req); }
