import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { onPoolError } from "@warehousd/broker";
import { mcpPlugin, envScopePlugin } from "./oauth";
import { ssoPlugin, ssoAdminPlugin, trustedOrigins } from "./sso";

export const LOCAL_LOGIN_DISABLED = process.env.WAREHOUSD_DISABLE_LOCAL_LOGIN === "true";

const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  options: "-c search_path=app",
});
// Without an "error" listener, pg escalates an idle-client failure to an unhandled error
// and the process exits — a Postgres restart would take the app down with it.
appPool.on("error", onPoolError("auth"));

// Better Auth manages user/session/account/verification tables in the `app` schema,
// alongside the hand-written app.grants / app.audit_events (createAppSchema). The two
// never touch the same table names, so create-if-not-exists on both sides is safe.
export const auth = betterAuth({
  // Keep Better Auth tables in the `app` schema (not public), matching the rest of the platform.
  database: appPool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8722",
  emailAndPassword: {
    // Local credentials are the bootstrap/demo fallback (see docs/architecture.md). Kill switch disables them entirely.
    enabled: !LOCAL_LOGIN_DISABLED,
    requireEmailVerification: false,
    minPasswordLength: 4,
  },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "member", input: false },
      orgId: { type: "string", defaultValue: "default", input: false },
    },
  },
  trustedOrigins: trustedOrigins(),
  plugins: [mcpPlugin, envScopePlugin(appPool), ssoPlugin(appPool), ssoAdminPlugin()],
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "member";
  orgId?: string;
};
