import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { listClientSecrets, createClientSecret } from "@warehousd/broker";
import { getAppPool } from "../../lib/broker";
import { requireRole } from "../../../lib/authz";
import { orgOf } from "../../../lib/session";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const org = orgOf(guard.user);
  const app = getAppPool();
  const r = await app.query(
    `select a."clientId" as "clientId",
            coalesce(p.display_name, a.name) as "displayName",
            p.allowed_scopes as "allowedScopes",
            p.allowed_collections as "allowedCollections",
            p.mode,
            p.robot_user_id as "robotUserId",
            p.trusted_issuer_id as "trustedIssuerId",
            a."createdAt" as "createdAt"
     from app."oauthApplication" a
     join app.client_policies p on p.client_id = a."clientId"
     where p.org_id = $1
     order by a."createdAt" desc`,
    [org]);

  const keys = await Promise.all(
    r.rows.map(async (row) => ({
      clientId: row.clientId,
      displayName: row.displayName,
      allowedScopes: row.allowedScopes,
      allowedCollections: row.allowedCollections,
      mode: row.mode,
      robotUserId: row.robotUserId,
      trustedIssuerId: row.trustedIssuerId,
      createdAt: row.createdAt,
      secrets: await listClientSecrets(app, row.clientId, org),
    }))
  );

  return Response.json({ keys });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const org = orgOf(guard.user);
  const {
    name,
    mode,
    trustedIssuerId,
    robotUserId,
    allowedCollections,
    expiresAt,
  } = await req.json();

  if (!name || !mode) {
    return Response.json({ error: "missing_name_or_mode" }, { status: 400 });
  }

  if (mode === "delegated" && !trustedIssuerId) {
    return Response.json(
      { error: "delegated_mode_requires_trusted_issuer" },
      { status: 400 }
    );
  }

  if (mode === "headless" && !robotUserId) {
    return Response.json(
      { error: "headless_mode_requires_robot_user_id" },
      { status: 400 }
    );
  }

  const app = getAppPool();
  const id = randomBytes(16).toString("hex");
  const clientId = randomBytes(16).toString("hex");

  // Create the client
  await app.query(
    `insert into app."oauthApplication" ("id","clientId","clientSecret",name,type,"redirectUrls","userId","createdAt","updatedAt")
     values ($1,$2,$3,$4,'web','[]',$5,now(),now())`,
    [id, clientId, randomBytes(32).toString("hex"), name, guard.user.id]
  );

  // Upsert the policy
  await app.query(
    `insert into app.client_policies (client_id, org_id, display_name, allowed_scopes, mode, allowed_collections, trusted_issuer_id, robot_user_id)
     values ($1, $2, $3, '{env:dev}', $4, $5, $6, $7)
     on conflict (client_id) do update set display_name=$3, mode=$4, allowed_collections=$5, trusted_issuer_id=$6, robot_user_id=$7`,
    [clientId, org, name, mode, allowedCollections || null, trustedIssuerId || null, robotUserId || null]
  );

  // Create the first secret
  const expiryDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const { secret } = await createClientSecret(
    app,
    clientId,
    org,
    expiryDate,
    guard.user.id,
    "dev"
  );

  return Response.json({ clientId, secret }, { status: 201 });
}
