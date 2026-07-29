import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";

interface OIDCUser {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

export async function startFakeIdp(opts: { users: OIDCUser[] }) {
  // An ephemeral port, like the other in-test servers (sso-admin, admin-sso-ui,
  // token-exchange): two suites use this helper, and with test files running in parallel a
  // fixed port makes whichever one starts second fail with EADDRINUSE. Assigned once the
  // listener is bound — every handler below reads it per request, which is after that.
  let issuer = "";

  let currentUser: OIDCUser | null = null;
  const codeToUser = new Map<string, OIDCUser>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", issuer);
    const path = url.pathname;

    if (path === "/.well-known/openid-configuration" && req.method === "GET") {
      const config = {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "profile", "email"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(config));
    } else if (path === "/authorize" && req.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");

      if (!redirectUri || !state || !currentUser) {
        res.writeHead(400);
        res.end("Missing redirect_uri, state, or no user set");
        return;
      }

      const code = randomBytes(16).toString("hex");
      codeToUser.set(code, currentUser);

      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);

      res.writeHead(302, { location: callbackUrl.toString() });
      res.end();
    } else if (path === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        // Ignore PKCE verifier, just return token
        const token = {
          access_token: randomBytes(32).toString("hex"),
          token_type: "Bearer",
          expires_in: 3600,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(token));
      });
    } else if (path === "/userinfo" && req.method === "GET") {
      // Bearer token is in Authorization header, but we just return the current user
      // (no actual validation since this is a fake IdP)
      if (!currentUser) {
        res.writeHead(401);
        res.end("No user set");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sub: currentUser.sub || currentUser.email,
        email: currentUser.email,
        email_verified: currentUser.email_verified ?? true,
        name: currentUser.name,
      }));
    } else if (path === "/jwks" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [] }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return new Promise<{
    issuer: string;
    setNextUser(u: OIDCUser): void;
    close(): Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // lib/auth reads WAREHOUSD_TRUSTED_ORIGINS once at module load and every caller starts
      // the IdP before setupWebDb triggers that import, so this is where the now-dynamic
      // callback origin has to be registered.
      process.env.WAREHOUSD_TRUSTED_ORIGINS ??= "http://127.0.0.1:8780";
      process.env.WAREHOUSD_TRUSTED_ORIGINS += `,${issuer}`;
      resolve({
        issuer,
        setNextUser(u: OIDCUser) {
          currentUser = u;
        },
        close() {
          return new Promise((done) => {
            server.close(done);
          });
        },
      });
    });
  });
}
