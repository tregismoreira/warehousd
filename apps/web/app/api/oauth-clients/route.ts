import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { upsertClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../../lib/broker";
import { requireRole } from "../../../lib/authz";
import { readJson } from "../../../lib/rest";

// §6.1: clients are an IT concern. Creation is admin-only; promotion stays manager-or-admin
// (a manager signs off on an app reaching live, an admin owns the credential inventory).
export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  // Left join: a dynamically registered client (RFC 7591) may have no policy row yet, and
  // getClientPolicy treats a missing row as {env:dev} — mirror that here, never allow-all.
  const r = await getAppPool().query(`
    select a."clientId"                      as "clientId",
           coalesce(p.display_name, a.name)  as "displayName",
           coalesce(p.allowed_scopes, '{env:dev}') as "allowedScopes",
           p.promoted_at                     as "promotedAt",
           p.promoted_by                     as "promotedBy",
           a."createdAt"                     as "createdAt",
           (select max(t."createdAt") from app."oauthAccessToken" t
             where t."clientId" = a."clientId") as "lastTokenAt"
    from app."oauthApplication" a
    left join app.client_policies p on p.client_id = a."clientId"
    order by a."createdAt" desc`);
  return Response.json({ clients: r.rows });
}

// Manually created clients (§6.1 "User-built apps") always start at {env:dev} — no
// creation-time override, regardless of what the request body asks for.
export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { name } = body.value as { name?: string };

  const id = randomBytes(16).toString("hex");
  const clientId = randomBytes(16).toString("hex");
  const clientSecret = randomBytes(32).toString("hex");
  const app = getAppPool();
  await app.query(
    `insert into app."oauthApplication" ("id","clientId","clientSecret",name,type,"redirectUrls","userId","createdAt","updatedAt")
     values ($1,$2,$3,$4,'web','[]',$5,now(),now())`,
    [id, clientId, clientSecret, name ?? "Untitled client", guard.user.id],
  );
  await upsertClientPolicy(app, clientId, name ?? null, ["env:dev"]);

  // The secret is returned here and never again — GET deliberately omits it.
  return Response.json({ clientId, clientSecret });
}
