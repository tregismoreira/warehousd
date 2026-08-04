import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";

interface OIDCUser {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  // Anything else the IdP asserts. Group claims live here — the SSO role-mapping suite needs an
  // IdP that sends one, and naming the claim in the fixture rather than in this type keeps the
  // helper indifferent to which claim a deployment happens to use.
  [claim: string]: unknown;
}

export async function startFakeIdp(_opts: { users: OIDCUser[] }) {
  // An ephemeral port, like the other in-test servers (sso-admin, admin-sso-ui,
  // token-exchange): two suites use this helper, and with test files running in parallel a
  // fixed port makes whichever one starts second fail with EADDRINUSE. Assigned once the
  // listener is bound — every handler below reads it per request, which is after that.
  let issuer = "";

  let currentUser: OIDCUser | null = null;
  const codeToUser = new Map<string, OIDCUser>();

  // node:http never awaits its handler, so a throw inside `handle` used to become an unhandled
  // rejection and leave the request hanging until the client timed out. Wrapping it turns the same
  // failure into a 500 the test can see.
  // Async even though no branch awaits today: the wrapper's `.catch` below is then the single
  // failure path, and stays so when one of them does.
  // eslint-disable-next-line @typescript-eslint/require-await
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
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
      // The body is accumulated nowhere on purpose — this endpoint ignores the PKCE verifier (see
      // below) and nothing else in it is read. `resume()` is still required: without a consumer the
      // request stream stays paused and `end` never fires.
      req.resume();
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
      res.end(
        JSON.stringify({
          ...currentUser,
          sub: currentUser.sub || currentUser.email,
          email: currentUser.email,
          email_verified: currentUser.email_verified ?? true,
          name: currentUser.name,
        }),
      );
    } else if (path === "/jwks" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [] }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error("[fake-idp] handler failed", err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
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
          // `server.close(cb)` hands its callback an optional Error, which is not a Promise
          // resolution value — wrap rather than pass `resolve` straight through.
          return new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        },
      });
    });
  });
}
