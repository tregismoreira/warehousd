import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { onPoolError, loadConfig } from "@warehousd/broker";
import { mcpPlugin, envScopePlugin } from "./oauth";
import { ssoPlugin, ssoAdminPlugin, trustedOrigins } from "./sso";
import { lockoutPlugin } from "./lockout";

export const LOCAL_LOGIN_DISABLED = process.env.WAREHOUSD_DISABLE_LOCAL_LOGIN === "true";

// The demo personas' password is literally "demo", and the test suite seeds them whether or not
// demo mode is on — so the floor has to be relaxed for anything that is not a production
// deployment, plus a deliberate demo deployment, rather than for demo mode alone.
const SHORT_PASSWORDS_OK =
  process.env.NODE_ENV !== "production" || process.env.WAREHOUSD_DEMO === "true";

const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:8722";
// The Secure flag follows the deployed scheme rather than NODE_ENV, for the same reason
// SHORT_PASSWORDS_OK does not key off NODE_ENV alone: a production build served over plain http
// (docker compose on a laptop) has to stay loggable-into, and a dev build behind an https tunnel
// still needs Secure cookies.
const IS_HTTPS = BASE_URL.startsWith("https://");

const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  options: "-c search_path=app",
});
// Without an "error" listener, pg escalates an idle-client failure to an unhandled error
// and the process exits — a Postgres restart would take the app down with it.
appPool.on("error", onPoolError("auth"));

// Better Auth manages user/session/account/verification tables in the `app` schema, alongside the
// ones our own migrations own — app.grants, app.audit_events, app.login_attempts. The two
// migrators never touch the same table names, so running both against one schema is safe. Ours
// runs first: migration 0001 deliberately carries no FK to Better Auth's tables, because they do
// not exist yet at that point.
export const auth = betterAuth({
  // Keep Better Auth tables in the `app` schema (not public), matching the rest of the platform.
  database: appPool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: BASE_URL,
  emailAndPassword: {
    // Local credentials are the bootstrap/demo fallback (see docs/architecture.md). Kill switch disables them entirely.
    enabled: !LOCAL_LOGIN_DISABLED,
    requireEmailVerification: false,
    // 4 exists only so the demo personas can hold the password "demo". Applying it unconditionally
    // meant a production deployment accepted four-character passwords — a floor set by a fixture.
    // A real deployment falls through to Better Auth's default of 8.
    ...(SHORT_PASSWORDS_OK ? { minPasswordLength: 4 } : {}),
  },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "member", input: false },
      orgId: { type: "string", defaultValue: "default", input: false },
    },
  },
  session: {
    // 8 hours — a working day. The default is 7, which for a console that approves grants and
    // reads governed data is a long time for a walked-away-from laptop to stay live.
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 60,
  },
  advanced: {
    useSecureCookies: IS_HTTPS,
    defaultCookieAttributes: {
      httpOnly: true,
      secure: IS_HTTPS,
      // "lax", never "strict": the OAuth authorize step and the SSO callback both return through
      // a cross-site redirect, and a Strict cookie is withheld on that hop — the MCP connector
      // and every SSO login would break. The CSRF gap Lax leaves on the credential endpoints is
      // closed by the Origin check in middleware.ts.
      sameSite: "lax",
    },
    // Deliberately no cookiePrefix: middleware.ts calls getSessionCookie(req) with no config, and
    // a custom prefix would make that lookup miss on every gated route.
  },
  trustedOrigins: trustedOrigins(),
  plugins: [
    mcpPlugin,
    envScopePlugin(appPool),
    // The config is read straight from disk here rather than through `getConfig` in
    // app/lib/broker. That module imports @warehousd/providers for the embedder, and this file is
    // imported by apps/web/scripts/entrypoint.ts, which the image runs under `tsx` — unbundled —
    // BEFORE `next start`. The runtime image carries packages/broker and apps/web but not
    // packages/providers (see apps/web/Dockerfile): the app routes never notice, because
    // `next build` bundles the embedder for them, but an unbundled import resolves a dangling
    // workspace symlink and kills the entrypoint before the server ever starts. Nothing in this
    // file may reach app/lib/broker for that reason. The CLI lifecycle e2e is what catches it.
    //
    // Re-reading per provisioning is not a cost worth caching: it happens once per new SSO
    // account, and picking up an edited group map without a restart is a feature.
    ssoPlugin(appPool, () => loadConfig(process.env.WAREHOUSD_PROJECT_DIR ?? process.cwd())),
    ssoAdminPlugin(),
    lockoutPlugin(appPool),
  ],
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "member";
  orgId?: string;
};
