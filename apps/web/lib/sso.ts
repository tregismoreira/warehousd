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
//
// `warning` names the two ways this silently does nothing, because both of them look identical
// from the outside: everyone keeps landing on `member` and no error is raised anywhere. Neither
// can be caught when the config is parsed — providers are registered at runtime, and the claim
// only exists once a user signs in — so the check has to happen here and be reported by the
// caller. Returned rather than logged so the function stays pure and the message is testable.
export function roleForSsoUser(
  cfg: WarehousdConfig,
  providerId: string,
  userInfo: Record<string, unknown>,
): { role: AppRole; warning: string | null } {
  const providers = cfg.sso?.providers;
  const p = providers?.[providerId];
  if (!p) {
    // A deployment with no map at all is the ordinary case and says nothing. A deployment that
    // configured one and named a provider that never signs anyone in has a typo, and the two are
    // only distinguishable here.
    const configured = Object.keys(providers ?? {});
    return {
      role: "member",
      warning: configured.length
        ? `no group map for provider "${providerId}" (configured: ${configured.join(", ")}) — every user from it is provisioned member`
        : null,
    };
  }

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

  // The claim missing entirely is the misconfiguration worth naming: better-auth hands this hook a
  // MAPPED user-info object, so a claim the provider registration did not list under
  // `mapping.extraFields` never arrives however faithfully the IdP sends it. An empty list is a
  // different thing — the IdP answered, the user is in no group — and is not worth a line.
  const warning =
    raw === undefined
      ? `group claim "${p.group_claim}" absent from provider "${providerId}" user info — map it under the provider's mapping.extraFields, or the group map cannot apply`
      : null;
  return { role: best, warning };
}

// `getCfg` rather than a config: it is resolved when a user is actually provisioned, so an
// operator editing the group map does not have to restart the server, and constructing the auth
// object never depends on the config (or the data pools behind it) being loadable yet.
export function ssoPlugin(app: Pool, getCfg: () => WarehousdConfig) {
  return sso({
    // JIT provisioning: the role comes from the IdP's groups when the provider declares a mapping
    // in warehousd.yml, and is `member` otherwise; an admin promotes in the UI either way.
    //
    // Registration only (isRegister), deliberately — `provisionUserOnEveryLogin` is left off. On
    // every login the map would re-derive the role from the IdP, which means silently undoing an
    // admin's promotion in the console and demoting anyone whose groups changed. That contradicts
    // the no-demotion-on-link invariant this hook has always had. Re-applying the map to an
    // existing account is a deliberate act: change the role in Admin → Users.
    provisionUser: async ({ user, userInfo, provider }) => {
      const { role, warning } = roleForSsoUser(getCfg(), provider.providerId, userInfo);
      // The provider id and the claim name; never the user, the email, or the claim's value.
      if (warning) console.warn(`[sso] ${warning}`);
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
