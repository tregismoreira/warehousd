import { betterAuth } from "better-auth";
import { Pool } from "pg";

export const LOCAL_LOGIN_DISABLED = process.env.SANDBOXD_DISABLE_LOCAL_LOGIN === "true";

// Better Auth manages user/session/account/verification tables in the `app` schema,
// alongside the hand-written app.grants / app.audit_events (createAppSchema). The two
// never touch the same table names, so create-if-not-exists on both sides is safe.
export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.APP_DATABASE_URL }),
  // Keep Better Auth tables in the `app` schema (not public), matching the rest of the platform.
  advanced: { database: { schema: "app" } },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8722",
  emailAndPassword: {
    // Local credentials are the bootstrap/demo fallback (SPECS §6.2). Kill switch disables them entirely.
    enabled: !LOCAL_LOGIN_DISABLED,
    requireEmailVerification: false,
  },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "member", input: false },
    },
  },
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "member";
};
