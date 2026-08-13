import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
import {
  verifyClientSecret,
  getClientPolicy,
  getTrustedIssuer,
  hasApprovedLiveGrant,
  resolveIssuedEnvScope,
  narrowPolicyToKeyEnv,
} from "@warehousd/broker";
import { getAppPool } from "../../lib/broker";
import { rateLimit } from "../../../lib/rate-limit";

// Generous by design: a machine client mints a 15-minute token, so a legitimate one asks a few
// times an hour, not 30 times a minute. The number is a cost cap, not a quota.
const TOKEN_RATE_LIMIT = { max: 30, windowMs: 60_000 };

// Asymmetric only, and named explicitly rather than left to the token's own header. A remote
// JWKS only ever yields asymmetric keys, so an HS* token could not verify against one anyway —
// but "could not" here depends on a property of another library, and alg confusion is cheap
// enough to close directly.
const SUBJECT_TOKEN_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];

// createRemoteJWKSet caches fetched keys and handles rotation, but only for the lifetime of the
// object — constructing one per request threw that cache away and made every exchange an
// outbound fetch to the IdP, which is both slow and a lever for anyone who can drive exchanges.
// Keyed on the URI as well as the issuer id so re-pointing an issuer's jwks_uri takes effect.
//
// The separator is a NUL, written as an escape rather than as a literal byte: neither an issuer id
// nor a URL can contain one, so no pair of them can collide by spelling. It used to be a literal
// \0 in the source, which made git treat this whole file as binary and its diffs unreviewable.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(issuerId: string, jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  const key = `${issuerId}\0${jwksUri}`;
  let set = jwksCache.get(key);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(key, set);
  }
  return set;
}

// The subject is matched against app."user".email, so whatever claim `subject_claim` names has to
// carry an email address. Checking the shape here turns "the IdP put an opaque uuid in `sub`"
// from a silent no-match into a refusal, and it is what makes the email_verified check below
// coherent — that claim is only meaningful about an address.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// An IdP that has not verified the address has not established that this token's holder controls
// it, and the address is the whole binding to a local user. Without this, an IdP allowing signup
// with an unverified corporate address hands out that user's grants.
//
// Note what this does NOT cover: an operator who points `subject_claim` at a user-mutable
// display claim such as preferred_username is trusting that claim as an identity, and
// email_verified says nothing about a claim that is not the email. That is recorded in
// SECURITY.md as an operator responsibility rather than papered over here.
function subjectOf(payload: JWTPayload, subjectClaim: string): string | null {
  const raw = payload[subjectClaim];
  if (typeof raw !== "string" || !EMAIL_SHAPE.test(raw)) return null;
  if (payload.email_verified !== true) return null;
  return raw;
}

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

  // Cap attempts per presented client_id before any credential is checked.
  //
  // Guessing a key is not the threat — 96 bits of CSPRNG behind a checksum, and
  // validateSecretFormat rejects a malformed one before it costs a database round trip or an
  // scrypt derivation. What this bounds is online guessing against a key whose prefix is already
  // known, and generic abuse of an endpoint that had no limit at all. Keyed per client rather
  // than globally on purpose: a global counter would let one attacker lock every other client out.
  const attemptedClientId = hasBasicAuth
    ? Buffer.from(authHeader!.slice(6), "base64").toString().split(":", 2)[0]
    : params.get("client_id");
  if (attemptedClientId) {
    const limit = rateLimit(`v1-token:${attemptedClientId}`, TOKEN_RATE_LIMIT);
    if (!limit.ok) {
      return new Response(JSON.stringify({ error: "slow_down" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "retry-after": String(limit.retryAfterSeconds),
        },
      });
    }
  }

  // Authenticate the client. `env` is the ceiling the presented key carries in its own prefix; it
  // is read from the stored prefix rather than from the string the caller sent.
  let clientAuth: { clientId: string; workspaceId: string; env: "dev" | "live" } | null = null;

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
    clientAuth = { clientId, workspaceId: verified.workspaceId, env: verified.env };
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
      clientAuth = { clientId, workspaceId: verified.workspaceId, env: verified.env };
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

    const issuer = await getTrustedIssuer(pool, policy.trustedIssuerId, clientAuth.workspaceId);
    if (!issuer) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // Verify JWT
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(subjectToken, jwksFor(issuer.id, issuer.jwksUri), {
        issuer: issuer.issuer,
        audience: issuer.audience,
        algorithms: SUBJECT_TOKEN_ALGS,
        // jose validates only the claims a token actually carries, so a subject token with no
        // `exp` verified forever — a one-time capture stayed usable indefinitely. Requiring the
        // claim is what makes the expiry check load-bearing rather than optional.
        requiredClaims: ["exp"],
      });
      payload = verified.payload;
    } catch {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // Resolve subject claim (default 'sub' if unset)
    const subject = subjectOf(payload, issuer.subjectClaim || "sub");
    if (!subject) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // Look up user by email within the workspace
    const userResult = await pool.query(
      `select id from app."user" where email=$1 and "workspaceId"=$2 limit 1`,
      [subject, clientAuth.workspaceId],
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

  // Resolve scopes. Every token this endpoint issues carries exactly one env scope, or none is
  // issued at all: the env a token reaches has to be a property of the token, not a default
  // applied by whichever context constructor reads it later.
  const requestedScopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const liveEligible = await hasApprovedLiveGrant(pool, userId, clientAuth.workspaceId);

  // Three gates, ANDed, and the key's own prefix is the first of them: a `whd_dev_` key has
  // `env:live` struck from the policy before anything else is considered, so it cannot reach real
  // data however the policy is widened later — which is the property the prefix advertises by
  // being printed on the key. It only narrows; a `whd_live_` key still needs the policy to allow
  // `env:live` and the user to hold an approved, unexpired live grant.
  const envScope = resolveIssuedEnvScope({
    requested: requestedScopes,
    policy: narrowPolicyToKeyEnv(policy, clientAuth.env),
    liveEligible,
  });

  if (!envScope) {
    // The client's policy allows no environment at all. Previously this minted a token with an
    // empty scope string, which every reader then treated as dev.
    return new Response(JSON.stringify({ error: "invalid_scope" }), {
      status: 400,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const scopeString = envScope;

  // Mint token.
  //
  // This endpoint issues no refresh token: it serves client_credentials and token-exchange, and
  // both callers hold a credential they can simply present again — RFC 6749 §4.4.3 says as much
  // for client_credentials ("a refresh token SHOULD NOT be included").
  //
  // Better Auth owns this table and declares refreshToken NOT NULL UNIQUE, so a value has to go
  // in. It used to be 32 fresh random bytes, which read as a credential, was never returned to
  // the caller, and was stored already expired — an unusable secret per exchange. A marked uuid
  // says what it is instead, and refreshTokenExpiresAt in the past is the second, independent
  // reason nothing can redeem it.
  const accessToken = randomBytes(32).toString("hex");

  try {
    await pool.query(
      `insert into app."oauthAccessToken"
         (id,"accessToken","refreshToken","accessTokenExpiresAt","refreshTokenExpiresAt",
          "clientId","userId",scopes,"createdAt","updatedAt")
       values (gen_random_uuid(),$1,'unused:' || gen_random_uuid(),
               now() + interval '15 minutes', now() - interval '1 second',
               $2,$3,$4, now(), now())`,
      [accessToken, clientAuth.clientId, userId, scopeString],
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
    },
  );
}
