import type { NextRequest } from "next/server";
import { deriveRestCaller } from "../../../../../../../lib/rest-context";
import { getBroker } from "../../../../../../lib/broker";
import { unauthenticated, refuse, ok, readJson } from "../../../../../../../lib/rest";

// A document's ACL over REST. Deliberately NOT an MCP tool: an untrusted proposer must not be able
// to widen access to anything, and a tool the model can call is exactly that.
//
// Authorisation is not a grant verb. It is the client's `can_manage_acl` policy flag, read from
// the database by the broker — this route supplies identity (`deriveRestCaller`) and nothing else,
// so an adapter cannot assert an authority it does not hold.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> },
) {
  const caller = await deriveRestCaller(req);
  if (!caller) return unauthenticated();

  const { c, id } = await params;
  const result = await getBroker().broker.getDocumentAcl(
    caller.ctx,
    { kind: "client", clientId: caller.clientId },
    { collection: c, id },
  );
  if (!result.ok) return refuse(result.reason);
  return ok(result);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> },
) {
  const caller = await deriveRestCaller(req);
  if (!caller) return unauthenticated();

  const { c, id } = await params;
  const body = await readJson(req);
  if (!body.ok) return refuse("invalid_intent");

  // Unvalidated on purpose: `principals` is `unknown` to setDocumentAcl, which is where the
  // namespace rule lives. Checking it here as well would be a second copy of a rule that decides
  // who may read a document.
  const result = await getBroker().broker.setDocumentAcl(
    caller.ctx,
    { kind: "client", clientId: caller.clientId },
    { collection: c, id, principals: body.value.principals },
  );
  if (!result.ok) return refuse(result.reason);
  return ok(result);
}

// Un-restricting a document is the same write with an empty list — the broker removes the row —
// so DELETE routes to it rather than being a second path with its own rules.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ c: string; id: string }> },
) {
  const caller = await deriveRestCaller(req);
  if (!caller) return unauthenticated();

  const { c, id } = await params;
  const result = await getBroker().broker.setDocumentAcl(
    caller.ctx,
    { kind: "client", clientId: caller.clientId },
    { collection: c, id, principals: [] },
  );
  if (!result.ok) return refuse(result.reason);
  return ok(result);
}
