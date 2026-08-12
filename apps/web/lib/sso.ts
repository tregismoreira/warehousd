import { sso } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx, APIError } from "better-auth/api";
import type { Pool } from "pg";
import {
  APP_ROLES,
  DEFAULT_WORKSPACE_ID,
  setMember,
  setUserGroups,
  type AppRole,
  type WarehousdConfig,
} from "@warehousd/broker";

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

// The groups the IdP asserted on this login, or `null` when it asserted nothing at all.
//
// The distinction is the whole of the "IdP stopped sending groups" rule, and it is the same one
// `roleForSsoUser` makes above:
//
//   null   the claim is absent — the provider registration did not map it, or the IdP dropped it.
//          Nothing is known about this user's groups, so nothing is changed. Wiping membership on
//          the strength of a claim that never arrived would revoke access from a configuration
//          mistake.
//   []     the claim arrived and is empty. The IdP answered: this user is in no group. That is a
//          fact, and sso-sourced membership is cleared to match it.
//
// Console-managed rows (`source: 'manual'`) are untouched either way — setUserGroups replaces only
// the source it is given.
export function assertedGroups(
  cfg: WarehousdConfig,
  providerId: string,
  userInfo: Record<string, unknown>,
): string[] | null {
  const p = cfg.sso?.providers?.[providerId];
  if (!p) return null;
  const raw = userInfo[p.group_claim];
  if (raw === undefined || raw === null) return null;
  // A single-group IdP may send a bare string rather than a list of one — same shape rule as
  // roleForSsoUser, so the role and the membership can never disagree about what was asserted.
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return list.filter((g): g is string => typeof g === "string" && g.length > 0);
}

// True exactly once per (user, provider): the first time this pair is seen. Used to keep role
// provisioning a REGISTRATION act while group membership syncs on every login.
//
// Better Auth's sso plugin gives `provisionUser` no "is this a registration?" flag and only a
// `provisionUserOnEveryLogin` switch, so without a marker the only way to sync groups per login is
// to re-derive the role per login — which would silently undo an admin's promotion in the console
// and demote anyone whose IdP groups changed. `insert … on conflict do nothing returning` answers
// in one statement, so two concurrent logins cannot both read as the first.
async function firstProvision(app: Pool, userId: string, providerId: string): Promise<boolean> {
  const r = await app.query(
    `insert into app.sso_provisioned (user_id, provider_id) values ($1,$2)
     on conflict (user_id, provider_id) do nothing returning user_id`,
    [userId, providerId],
  );
  return (r.rowCount ?? 0) > 0;
}

// `getCfg` rather than a config: it is resolved when a user is actually provisioned, so an
// operator editing the group map does not have to restart the server, and constructing the auth
// object never depends on the config (or the data pools behind it) being loadable yet.
export function ssoPlugin(app: Pool, getCfg: () => WarehousdConfig) {
  return sso({
    // Runs on every login (see provisionUserOnEveryLogin below), and does two different things.
    //
    // ROLE — registration only, as it always was. On every login the map would re-derive the role
    // from the IdP, which means silently undoing an admin's promotion in the console and demoting
    // anyone whose groups changed. Re-applying the map to an existing account stays a deliberate
    // act: change the role in Admin → Users.
    //
    // GROUP MEMBERSHIP — every login, because it is not a decision somebody made in the console,
    // it is a fact about the IdP that per-document ACLs are evaluated against. A membership synced
    // once at registration would leave `group:` principals frozen at whatever the user's first
    // login asserted, which is worse than not offering them.
    provisionUser: async ({ user, userInfo, provider }) => {
      const cfg = getCfg();
      const r = await app.query<{ workspaceId: string | null }>(
        `select "workspaceId" from app."user" where id = $1`,
        [user.id],
      );
      const workspaceId = r.rows[0]?.workspaceId ?? DEFAULT_WORKSPACE_ID;

      if (await firstProvision(app, user.id, provider.providerId)) {
        const { role, warning } = roleForSsoUser(cfg, provider.providerId, userInfo);
        // The provider id and the claim name; never the user, the email, or the claim's value.
        if (warning) console.warn(`[sso] ${warning}`);
        await app.query(`update app."user" set role = $2 where id = $1`, [user.id, role]);
        // Authorization reads workspace membership (lib/authz.ts), not this column — the
        // databaseHooks.user.create.after in lib/auth.ts already gave this user a 'member' row at
        // JIT-provisioning time, before the IdP's groups were known. Kept in sync here for the
        // same reason apps/web/app/api/admin/users/[userId]/route.ts is: a role change that
        // stopped at app."user" would change what the console displays without changing what the
        // user can do.
        await setMember(app, { workspaceId, userId: user.id, role });
      }

      const groups = assertedGroups(cfg, provider.providerId, userInfo);
      if (groups === null) return;
      await setUserGroups(app, {
        workspaceId,
        userId: user.id,
        groups,
        source: "sso",
      });
    },
    provisionUserOnEveryLogin: true,
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
