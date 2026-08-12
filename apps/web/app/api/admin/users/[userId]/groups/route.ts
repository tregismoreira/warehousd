import { NextRequest } from "next/server";
import { listUserGroups, setUserGroups } from "@warehousd/broker";
import { getAppPool } from "../../../../../lib/broker";
import { requireRole } from "../../../../../../lib/authz";
import { readJson } from "../../../../../../lib/rest";

// Console-managed group membership.
//
// Groups are what a `group:` principal on a per-document ACL resolves against, and they are
// warehousd's own record — never read from a token or a claim (see acl/principals.ts). Two things
// write them: an SSO login, which owns `source: 'sso'`, and this route, which owns
// `source: 'manual'`. Neither touches the other's rows, so re-syncing an IdP cannot silently drop
// a membership somebody granted by hand, and a hand edit cannot outlive the IdP's own answer.
//
// A deployment with no SSO at all still gets working groups this way, which is the reason this
// route exists rather than being left for later: without it, `group:` principals would be a
// feature only an IdP could reach.

export async function GET(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  const { userId } = await params;
  const app = getAppPool();
  const workspace = guard.workspaceId;

  // Scoped to the acting admin's workspace, and a user outside it reads as unknown rather than
  // forbidden — the same rule the sibling role route states: which ids exist elsewhere is not
  // this admin's to learn.
  const cur = await app.query(`select 1 from app."user" where id=$1 and "workspaceId"=$2`, [
    userId,
    workspace,
  ]);
  if (cur.rowCount === 0) return Response.json({ error: "unknown_user" }, { status: 404 });

  return Response.json({ groups: await listUserGroups(app, { workspaceId: workspace, userId }) });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  const { userId } = await params;
  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { groups } = body.value;
  if (!Array.isArray(groups) || !groups.every((g) => typeof g === "string" && g.length > 0))
    return Response.json({ error: "invalid_groups" }, { status: 400 });

  const app = getAppPool();
  const workspace = guard.workspaceId;
  const cur = await app.query(`select 1 from app."user" where id=$1 and "workspaceId"=$2`, [
    userId,
    workspace,
  ]);
  if (cur.rowCount === 0) return Response.json({ error: "unknown_user" }, { status: 404 });

  await setUserGroups(app, {
    workspaceId: workspace,
    userId,
    groups: groups as string[],
    source: "manual",
  });
  return Response.json({ groups: await listUserGroups(app, { workspaceId: workspace, userId }) });
}
