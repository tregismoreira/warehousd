import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { getAppPool } from "../../lib/broker";
import { upsertClientPolicy } from "@warehousd/broker";
import { getSessionUser } from "../../../lib/session";

// Manually created clients (§6.1 "User-built apps") always start at {env:dev} — no
// creation-time override, regardless of what the request body asks for. Promotion is a
// separate, manager/admin-only step (see [clientId]/promote/route.ts).
export async function POST(req: NextRequest) {
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { name } = await req.json();

  const id = randomBytes(16).toString("hex");
  const clientId = randomBytes(16).toString("hex");
  const clientSecret = randomBytes(32).toString("hex");
  const app = getAppPool();
  await app.query(
    `insert into app."oauthApplication" ("id","clientId","clientSecret",name,type,"redirectUrls","userId","createdAt","updatedAt")
     values ($1,$2,$3,$4,'web','[]',$5,now(),now())`,
    [id, clientId, clientSecret, name ?? "Untitled client", sessionUser.id]);
  await upsertClientPolicy(app, clientId, name ?? null, ["env:dev"]);

  return Response.json({ clientId, clientSecret });
}
