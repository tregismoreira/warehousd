import { sso } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx, APIError } from "better-auth/api";
import type { Pool } from "pg";

// Origins allowed as OIDC issuers/discovery hosts. Better Auth's discovery rejects
// loopback and RFC-1918 hosts outright (validateDiscoveryUrl -> discovery_private_host);
// a local test IdP or an on-prem corporate IdP must be listed here explicitly.
export function trustedOrigins(): string[] {
  return (process.env.WAREHOUSD_TRUSTED_ORIGINS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

export function ssoPlugin(app: Pool) {
  return sso({
    // JIT provisioning: the first SSO login lands as `member`; an admin promotes
    // in the UI. Runs on registration only (isRegister), so an existing admin who later
    // links an SSO account is never demoted.
    provisionUser: async ({ user }) => {
      await app.query(`update app."user" set role = 'member' where id = $1`, [user.id]);
    },
  });
}

// Gate Better Auth's SSO management endpoints to admin-only access
const SSO_ADMIN_PATHS = new Set([
  "/sso/register", "/sso/update-provider", "/sso/delete-provider",
  "/sso/get-provider", "/sso/providers",
  "/sso/verify-domain", "/sso/request-domain-verification",
]);

export function ssoAdminPlugin() {
  return {
    id: "sso-admin",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => SSO_ADMIN_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx: any) => {
            const session = await getSessionFromCtx(ctx);
            if (session?.user?.role !== "admin") {
              throw new APIError("FORBIDDEN", { message: "admin role required" });
            }
          }),
        },
      ],
    },
    // See the matching note in lib/oauth.ts's envScopePlugin — `satisfies` keeps Better Auth's
    // InferAPI intact across the plugins tuple in lib/auth.ts.
  } satisfies BetterAuthPlugin;
}
