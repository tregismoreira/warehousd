import { createHash, randomBytes } from "node:crypto";

// S256 PKCE pair. Better Auth's mcp/token endpoint verifies
// base64url(sha256(code_verifier)) === code_challenge — a literal identical string for both
// (as if code_challenge_method were "plain") never matches, and "plain" isn't enabled.
export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// Drives /mcp/authorize through Better Auth's real HTTP handler with a genuine Request.
// auth.api.mcpOAuthAuthorize({...}) does NOT populate ctx.request, which authorizeMCPOAuth
// requires (throws "request not found" otherwise) — only a real Request routed through
// auth.handler works for this endpoint.
//
// No consent step: the mcp plugin's authorize flow only defers to /oauth2/consent when the
// request sets prompt=consent, which none of our flows do. The env picker (rule 3) is the
// app's own custom redirect inserted by envScopePlugin's before-hook, not Better Auth's
// generic OIDC consent screen — this helper never needs to touch /oauth2/consent.
export async function authorizeAndGetCode(
  auth: { handler: (req: Request) => Promise<Response> },
  opts: {
    clientId: string;
    scope: string;
    cookie: string;
    challenge: string;
    extraParams?: Record<string, string>;
  },
): Promise<{ res: Response; code: string | null; location: string }> {
  const url = new URL("http://localhost:8722/api/auth/mcp/authorize");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", "http://localhost:9999/callback");
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(opts.extraParams ?? {})) url.searchParams.set(k, v);

  const res = await auth.handler(
    new Request(url, { method: "GET", headers: { cookie: opts.cookie } }),
  );
  const location = res.headers.get("location") ?? "";
  const code = location ? new URL(location, "http://localhost").searchParams.get("code") : null;
  return { res, code, location };
}
