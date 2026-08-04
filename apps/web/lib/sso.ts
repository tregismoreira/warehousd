import { sso } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx, APIError } from "better-auth/api";
import type { Pool } from "pg";
import { APP_ROLES, type AppRole, type WarehousdConfig } from "@warehousd/broker";

// Origins allowed as OIDC issuers/discovery hosts. Better Auth's discovery rejects
// loopback and RFC-1918 hosts outright (validateDiscoveryUrl -> discovery_private_host);
// a local test IdP or an on-prem corporate IdP must be listed here explicitly.
export function trustedOrigins(): string[] {
  return (process.env.WAREHOUSD_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The role a JIT-provisioned SSO user lands with, decided by the groups their IdP asserts.
//
// Pure, and exported, because this is the only place a login can hand out `admin` without a human
// deciding it — the rule is worth reading and testing on its own rather than inside a callback.
//
// Rules, in order:
//   - No mapping configured for this provider → `member`, exactly as before. Adding the feature
//     changes nothing for a deployment that does not use it.
//   - The claim absent, empty, or not a list of strings → the provider's `default_role`. An IdP
//     that stopped sending groups must not promote anyone; it also must not lock the login out,
//     which is why this is a role rather than a refusal.
//   - Otherwise the HIGHEST role any asserted group maps to. A user in both the managers and the
//     admins group is an admin; taking the lowest would make adding a group a demotion, which no
//     operator writing this map expects. Unmapped groups are ignored, not an error — an IdP's
//     group list is its own business and will contain plenty warehousd knows nothing about.
export function roleForSsoUser(
  cfg: WarehousdConfig,
  providerId: string,
  userInfo: Record<string, unknown>,
): AppRole {
  const p = cfg.sso?.providers?.[providerId];
  if (!p) return "member";

  const raw = userInfo[p.group_claim];
  // A single-group IdP may send a bare string rather than a list of one.
  const asserted = (typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : []).filter(
    (g): g is string => typeof g === "string",
  );

  const rank = (r: AppRole) => APP_ROLES.indexOf(r);
  let best = p.default_role;
  for (const g of asserted) {
    const mapped = Object.hasOwn(p.groups, g) ? p.groups[g] : undefined;
    if (mapped && rank(mapped) > rank(best)) best = mapped;
  }
  return best;
}

// `getCfg` rather than a config: it is resolved when a user is actually provisioned, so an
// operator editing the group map does not have to restart the server, and constructing the auth
// object never depends on the config (or the data pools behind it) being loadable yet.
export function ssoPlugin(app: Pool, getCfg: () => WarehousdConfig) {
  return sso({
    // JIT provisioning: the role comes from the IdP's groups when the provider declares a mapping
    // in warehousd.yml, and is `member` otherwise; an admin promotes in the UI either way.
    // Runs on registration only (isRegister), so an existing admin who later links an SSO account
    // is never demoted — and so a group mapping cannot demote anyone on a later login either.
    provisionUser: async ({ user, userInfo, provider }) => {
      const role = roleForSsoUser(getCfg(), provider.providerId, userInfo);
      await app.query(`update app."user" set role = $2 where id = $1`, [user.id, role]);
    },
  });
}

// Gate Better Auth's SSO management endpoints to admin-only access
const SSO_ADMIN_PATHS = new Set([
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/get-provider",
  "/sso/providers",
  "/sso/verify-domain",
  "/sso/request-domain-verification",
]);

export function ssoAdminPlugin() {
  return {
    id: "sso-admin",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => SSO_ADMIN_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
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
