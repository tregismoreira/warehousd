import { Pool } from "pg";
import { upsertClientPolicy, createClientSecret } from "@warehousd/broker";
import { setupWebDbWithData } from "./web-db";
import { getAppPool } from "../../app/lib/broker";

// Boots a fresh web database seeded with harbor's synthetic + live data, and an admin pool
// against it — the same two resources every /v1 integration suite needs before it can seed a
// grant or mint a token. Extracted from keyset-pagination.integration.test.ts so a second suite
// (revision-routes) does not have to re-derive the boot sequence.
export type Stack = {
  db: Awaited<ReturnType<typeof setupWebDbWithData>>;
  admin: Pool;
  end(): Promise<void>;
};

export async function withStack(label: string): Promise<Stack> {
  const db = await setupWebDbWithData(label);
  const admin = new Pool({ connectionString: db.appUrl, max: 4 });
  return {
    db,
    admin,
    async end() {
      await admin.end();
      await db.end();
    },
  };
}

// The header object a bearer-token request needs. A caller building a JSON request still adds
// its own content-type; this only ever names the one header every request in these suites shares.
export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// Mint a headless (client_credentials) access token for a robot user already granted access via
// requestGrant/approveGrant. Extracted verbatim from keyset-pagination.integration.test.ts, save
// for `db` and `scope` becoming parameters instead of a closed-over describe-block variable and a
// hardcoded "env:dev".
export async function mintHeadlessToken(
  db: Stack["db"],
  clientName: string,
  robotUserId: string,
  scope: string = "env:dev",
): Promise<string> {
  const app = getAppPool();
  const reg = await db.auth.api.registerMcpClient({
    body: { redirect_uris: ["http://localhost:9999/callback"], client_name: clientName },
    asResponse: true,
  } as any);
  const { client_id } = await reg.json();
  await upsertClientPolicy(app, client_id, clientName, [scope]);
  await app.query(
    `update app.client_policies set mode='headless', robot_user_id=$1 where client_id=$2`,
    [robotUserId, client_id],
  );
  const { secret } = await createClientSecret(
    app,
    client_id,
    "default",
    new Date(Date.now() + 86_400_000),
    "test",
  );

  const { POST } = await import("../../app/v1/token/route");
  const tokenReq = new Request("http://localhost:8722/v1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id,
      client_secret: secret,
      scope,
    }).toString(),
  });
  const res = await POST(tokenReq as any);
  return (await res.json()).access_token as string;
}
