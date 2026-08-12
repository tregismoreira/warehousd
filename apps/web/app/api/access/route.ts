import { NextRequest } from "next/server";
import { getBroker } from "../../lib/broker";
import { requireSession } from "../../../lib/authz";
import { deriveContext } from "../../../lib/session";

/**
 * `GET /api/access?collection=…&subject=…` — what a person can see, field by field, and why.
 *
 * Console-only by construction: there is no MCP tool for `explainAccess`, and the broker decides
 * who may ask about whom by reading the caller's role from the database rather than from anything
 * this route asserts. `subject` defaults to the caller, which is the self-diagnosis case a member
 * is entitled to without any role at all.
 *
 * Nothing it returns is a field value — see verbs/explain.ts.
 */
export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const collection = url.searchParams.get("collection");
  if (!collection) return Response.json({ error: "collection_required" }, { status: 400 });
  const subject = url.searchParams.get("subject") ?? guard.user.id;

  // The console session's context: user, workspace and the env cookie. `deriveContext` is the same one
  // every other console route uses, so the environment this answer describes is the environment
  // the rest of the page is showing.
  const ctx = await deriveContext(req);
  if (!ctx) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const result = await getBroker().broker.explainAccess(ctx, collection, subject);

  if (!result.ok) {
    const status =
      result.reason === "not_authorized" ? 403 : result.reason === "unknown_collection" ? 404 : 400;
    return Response.json({ error: result.reason }, { status });
  }
  return Response.json(result);
}
