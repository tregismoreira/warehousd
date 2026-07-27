import { NextRequest } from "next/server";
import { listDocumentPaths } from "@warehousd/broker";
import { getBroker, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

// Grant-authoring metadata: approvers only. The `env` param is the env of the grant
// being approved, which is a legitimate query parameter — it selects which
// environment's file list to show. It is NOT a BrokerContext env: listDocumentPaths
// builds its own {userId:"", env} for pool selection only.
export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;

  const collection = req.nextUrl.searchParams.get("collection") ?? "";
  const env = req.nextUrl.searchParams.get("env");
  if (env !== "dev" && env !== "live")
    return Response.json({ error: "invalid_env" }, { status: 400 });

  try {
    const paths = await listDocumentPaths(getBroker().pools, env, getConfig(), collection);
    return Response.json({ paths });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 400 });
  }
}
