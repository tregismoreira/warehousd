import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { listClientSecrets, createClientSecret } from "@warehousd/broker";
import { getAppPool } from "../../lib/broker";
import { requireRole } from "../../../lib/authz";
import { readJson } from "../../../lib/rest";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const workspace = guard.workspaceId;
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
     where p.workspace_id = $1
     order by a."createdAt" desc`,
    [workspace],
  );

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
      secrets: await listClientSecrets(app, row.clientId, workspace),
    })),
  );

  return Response.json({ keys });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const workspace = guard.workspaceId;
  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { name, mode, env, trustedIssuerId, robotUserId, allowedCollections, expiresAt } =
    body.value as {
      name?: string;
      mode?: string;
      env?: string;
      trustedIssuerId?: string;
      robotUserId?: string;
      allowedCollections?: string[];
      expiresAt?: string;
    };

  if (!name || !mode) {
    return Response.json({ error: "missing_name_or_mode" }, { status: 400 });
  }

  // The environment a key is minted for, chosen once and encoded in its prefix. `dev` is the
  // default because a key that reaches real data should be asked for rather than arrived at.
  // Refused rather than coerced: a typo that silently produced a dev key would be discovered as a
  // mysterious `invalid_scope` at token time.
  if (env !== undefined && env !== "dev" && env !== "live") {
    return Response.json({ error: "invalid_env" }, { status: 400 });
  }
  const keyEnv: "dev" | "live" = env === "live" ? "live" : "dev";

  if (mode === "delegated" && !trustedIssuerId) {
    return Response.json({ error: "delegated_mode_requires_trusted_issuer" }, { status: 400 });
  }

  if (mode === "headless" && !robotUserId) {
    return Response.json({ error: "headless_mode_requires_robot_user_id" }, { status: 400 });
  }

  const app = getAppPool();
  const id = randomBytes(16).toString("hex");
  const clientId = randomBytes(16).toString("hex");

  // Create the client
  await app.query(
    `insert into app."oauthApplication" ("id","clientId","clientSecret",name,type,"redirectUrls","userId","createdAt","updatedAt")
     values ($1,$2,$3,$4,'web','[]',$5,now(),now())`,
    [id, clientId, randomBytes(32).toString("hex"), name, guard.user.id],
  );

  // Upsert the policy. A live key's policy carries `env:dev` too — live is the ceiling, not an
  // exclusive mode, and a key that could reach real data but not generated data would be a strange
  // thing to hand anyone. The policy is only half the gate: /v1/token still narrows it by the
  // key's own prefix and still requires the user to hold an approved live grant.
  const allowedScopes = keyEnv === "live" ? "{env:dev,env:live}" : "{env:dev}";
  await app.query(
    `insert into app.client_policies (client_id, workspace_id, display_name, allowed_scopes, mode, allowed_collections, trusted_issuer_id, robot_user_id)
     values ($1, $2, $3, $8, $4, $5, $6, $7)
     on conflict (client_id) do update set display_name=$3, mode=$4, allowed_collections=$5, trusted_issuer_id=$6, robot_user_id=$7, allowed_scopes=$8`,
    [
      clientId,
      workspace,
      name,
      mode,
      allowedCollections || null,
      trustedIssuerId || null,
      robotUserId || null,
      allowedScopes,
    ],
  );

  // Create the first secret
  const expiryDate = expiresAt
    ? new Date(expiresAt)
    : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const { secret } = await createClientSecret(
    app,
    clientId,
    workspace,
    expiryDate,
    guard.user.id,
    keyEnv,
  );

  return Response.json({ clientId, secret, env: keyEnv }, { status: 201 });
}
