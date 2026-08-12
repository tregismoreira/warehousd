import { NextRequest } from "next/server";
import { listGroups } from "@warehousd/broker";
import { getBroker, getAppPool } from "../../../../../lib/broker";
import { requireRole } from "../../../../../../lib/authz";
import { deriveContext } from "../../../../../../lib/session";
import { restStatus } from "../../../../../../lib/rest";

// The console's half of ACL management. The REST route under /v1 is the client half; both go
// through the same two broker verbs, so neither can be the lenient one.
//
// `requireRole(req, "manager")` is the route guard — admin ⊃ manager — and the broker re-reads the
// role from `app."user"` regardless. That is not belt-and-braces: the broker is the trust boundary
// (invariant 1), and a route that could assert its caller's role would move the decision outside
// it. This guard is what turns "not authorised" into a 403 before it costs a database round trip.

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;
  const ctx = await deriveContext(req);
  if (!ctx) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const { name } = await params;
  const id = new URL(req.url).searchParams.get("id");
  // The group list is served alongside so the editor can offer `group:` principals that exist
  // rather than asking somebody to type a name and hope.
  const groups = await listGroups(getAppPool(), guard.workspaceId);
  if (!id) return Response.json({ acl: null, groups });

  const result = await getBroker().broker.getDocumentAcl(
    ctx,
    { kind: "console" },
    {
      collection: name,
      id,
    },
  );
  if (!result.ok)
    return Response.json({ error: result.reason }, { status: restStatus(result.reason) });
  return Response.json({ acl: result.acl, groups, auditId: result.auditId });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;
  const ctx = await deriveContext(req);
  if (!ctx) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const { name } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_intent" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return Response.json({ error: "invalid_intent" }, { status: 400 });
  const { id, principals } = body as { id?: unknown; principals?: unknown };
  if (typeof id !== "string" || !id)
    return Response.json({ error: "invalid_intent" }, { status: 400 });

  const result = await getBroker().broker.setDocumentAcl(
    ctx,
    { kind: "console" },
    {
      collection: name,
      id,
      principals,
    },
  );
  if (!result.ok)
    return Response.json({ error: result.reason }, { status: restStatus(result.reason) });
  return Response.json({ acl: result.acl, auditId: result.auditId });
}
