import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { jwtVerify, createRemoteJWKSet } from "jose";
import {
  DEFAULT_ORG_ID,
  verifyClientSecret,
  getClientPolicy,
  getTrustedIssuer,
  hasApprovedLiveGrant,
  resolveEnvScopes,
} from "@warehousd/broker";
import { getAppPool } from "../../lib/broker";

export async function POST(req: NextRequest) {
  const pool = getAppPool();
  const params = new URLSearchParams(await req.text());
  const grantType = params.get("grant_type");

  const authHeader = req.headers.get("authorization");
  const hasBasicAuth = authHeader?.startsWith("Basic ");
  const hasFormAuth = params.get("client_secret");

  // Reject requests with both Basic auth and form-field credentials before any verification
  if (hasBasicAuth && hasFormAuth) {
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 400,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  // Authenticate the client
  let clientAuth: { clientId: string; orgId: string } | null = null;

  if (hasBasicAuth) {
    const encoded = authHeader!.slice(6);
    const decoded = Buffer.from(encoded, "base64").toString();
    const [clientId, clientSecret] = decoded.split(":", 2);
    if (!clientSecret) {
      return new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    const verified = await verifyClientSecret(pool, clientSecret);
    if (!verified || verified.clientId !== clientId) {
      return new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    clientAuth = { clientId, orgId: verified.orgId };
  } else {
    const clientId = params.get("client_id");
    const clientSecret = params.get("client_secret");
    if (clientId && clientSecret) {
      const verified = await verifyClientSecret(pool, clientSecret);
      if (!verified || verified.clientId !== clientId) {
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      clientAuth = { clientId, orgId: verified.orgId };
    }
  }

  if (!clientAuth) {
    return new Response(JSON.stringify({ error: "invalid_client" }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const policy = await getClientPolicy(pool, clientAuth.clientId);

  let userId: string;

  if (grantType === "urn:ietf:params:oauth:grant-type:token-exchange") {
    // Delegated flow
    if (policy.mode === "headless") {
      return new Response(JSON.stringify({ error: "unauthorized_client" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    const subjectToken = params.get("subject_token");
    const subjectTokenType = params.get("subject_token_type");

    if (!subjectToken || subjectTokenType !== "urn:ietf:params:oauth:token-type:jwt") {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // Load trusted issuer
    if (!policy.trustedIssuerId) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    const issuer = await getTrustedIssuer(pool, policy.trustedIssuerId, clientAuth.orgId);
    if (!issuer) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // Verify JWT
    let payload: any;
    try {
      const jwks = createRemoteJWKSet(new URL(issuer.jwksUri));
      const verified = await jwtVerify(subjectToken, jwks, {
        issuer: issuer.issuer,
        audience: issuer.audience,
      });
      payload = verified.payload;
    } catch {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // Resolve subject claim (default 'sub' if unset)
    const subjectClaim = issuer.subjectClaim || "sub";
    const subject = payload[subjectClaim];

    if (!subject) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // Look up user by email within the org
    const userResult = await pool.query(
      `select id from app."user" where email=$1 and "orgId"=$2 limit 1`,
      [subject, clientAuth.orgId]
    );

    if (userResult.rowCount === 0) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    userId = userResult.rows[0].id;
  } else if (grantType === "client_credentials") {
    // Headless flow
    if (policy.mode === "delegated") {
      return new Response(JSON.stringify({ error: "unauthorized_client" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    if (!policy.robotUserId) {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    userId = policy.robotUserId;
  } else {
    return new Response(JSON.stringify({ error: "unsupported_grant_type" }), {
      status: 400,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  // Resolve scopes
  const requestedScopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const liveEligible = await hasApprovedLiveGrant(pool, userId, clientAuth.orgId);
  const resolvedScopes = resolveEnvScopes({
    requested: requestedScopes,
    policy,
    liveEligible,
  });

  const scopeString = resolvedScopes.join(" ");

  // Mint token
  const accessToken = randomBytes(32).toString("hex");
  const refreshToken = randomBytes(32).toString("hex");

  try {
    await pool.query(
      `insert into app."oauthAccessToken"
         (id,"accessToken","refreshToken","accessTokenExpiresAt","refreshTokenExpiresAt",
          "clientId","userId",scopes,"createdAt","updatedAt")
       values (gen_random_uuid(),$1,$2, now() + interval '15 minutes', now(),
               $3,$4,$5, now(), now())`,
      [accessToken, refreshToken, clientAuth.clientId, userId, scopeString]
    );
  } catch (err) {
    console.error("[v1/token] insert failed", err);
    return new Response(JSON.stringify({ error: "server_error" }), {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  return Response.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 900,
      scope: scopeString,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    },
    {
      headers: { "cache-control": "no-store" },
    }
  );
}
