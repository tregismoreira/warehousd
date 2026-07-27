import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { deriveTokenContext } from "../../lib/broker-context";
import { TOOLS, toolByName } from "../../lib/mcp-tools";

// The base URL is the configured issuer, never a Host header — a connector URL derived from
// an attacker-controlled header would send users' OAuth flows somewhere else.
const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:8722";

// Stateless streamable HTTP: a fresh Server + transport per request. A Server can only be
// connect()ed to one transport at a time, so a shared module-level instance would race under
// concurrent requests — this is the SDK's documented pattern for stateless deployments.
async function handle(req: Request): Promise<Response> {
  const ctx = await deriveTokenContext(req);
  if (!ctx) {
    return Response.json({ error: "unauthenticated" }, {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  const server = new Server({ name: "warehousd", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolByName(req.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "unknown_tool" }) }], isError: true };
    }
    try {
      const out = await tool.handler(ctx, req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    } catch (err) {
      // Never surface a raw error: prevent leaking schema details, stack traces, etc.
      // Log server-side for debugging, but return a generic error to the client.
      console.error("[mcp] tool handler failed", { tool: req.params.name, err });
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "internal_error" }) }], isError: true };
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function POST(req: Request) { return handle(req); }
export async function GET(req: Request) { return handle(req); }
export async function DELETE(req: Request) { return handle(req); }
