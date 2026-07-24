import { mcp } from "better-auth/plugins";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { Pool } from "pg";
import { getClientPolicy, hasApprovedLiveGrant, upsertClientPolicy } from "@warehousd/broker";

const ENV_SCOPES = ["env:dev", "env:live"] as const;

// env:dev / env:live are the ONLY scopes this plugin adds beyond Better Auth's OIDC defaults
// (openid, profile, email, offline_access). Rule enforcement (client policy intersection,
// live-grant eligibility, exactly-one-env, refresh re-evaluation) is added in lib/oauth.ts's
// envScopePlugin — see Tasks 3-6.
export const mcpPlugin = mcp({
  loginPage: "/login",
  oidcConfig: {
    scopes: ["env:dev", "env:live"],
    accessTokenExpiresIn: 900, // 15 min, per §6.1 rule 4
    allowDynamicClientRegistration: true,
  },
});

// §6.1 rules 1-4. Intersects the requested scope with the client's allow-list (rule 1) and
// the user's live-grant eligibility (rule 2) BEFORE Better Auth's own authorize handler runs,
// by rewriting ctx.query.scope in place — so escalation is impossible by construction, not by
// after-the-fact validation. Rules 3 (env picker) and 4 (refresh re-evaluation) are added in
// Tasks 6 and 7 respectively, in the same hook bodies below.
export function envScopePlugin(app: Pool) {
  return {
    id: "env-scope",
    hooks: {
      before: [
        {
          matcher: (ctx: { path: string }) => ctx.path === "/mcp/authorize",
          handler: createAuthMiddleware(async (ctx: any) => {
            const clientId = String(ctx.query?.client_id ?? "");
            const requested = String(ctx.query?.scope ?? "").split(" ").filter(Boolean);
            const requestedEnv = requested.filter((s) => (ENV_SCOPES as readonly string[]).includes(s));
            if (requestedEnv.length === 0) return;

            const policy = await getClientPolicy(app, clientId);
            let survivors = requestedEnv.filter((s) => policy.allowedScopes.includes(s));

            if (survivors.includes("env:live")) {
              const session = await getSessionFromCtx(ctx);
              const userId = session?.user?.id;
              const eligible = userId ? await hasApprovedLiveGrant(app, userId) : false;
              if (!eligible) survivors = survivors.filter((s) => s !== "env:live");
            }

            // Rule 3: exactly-one-env picker. When both env:dev and env:live survive rules 1-2,
            // redirect to the picker unless wh_env is set to a valid value.
            if (survivors.includes("env:dev") && survivors.includes("env:live")) {
              const picked = ctx.query?.wh_env;
              if (picked === "dev" || picked === "live") {
                survivors = [`env:${picked}`];
              } else {
                const params = new URLSearchParams(
                  Object.entries(ctx.query ?? {}).map(([k, v]) => [k, String(v)]),
                );
                throw ctx.redirect(`/oauth/env-picker?${params.toString()}`);
              }
            }

            // Mutate the existing ctx.query object's property in place — `ctx.query = {...}`
            // (reassigning to a new object) silently stops propagating to the endpoint handler
            // once this hook does another await after the reassignment site's first tick;
            // Better Auth's dispatch holds a reference to the original query object, and only
            // in-place mutation of that object is guaranteed visible downstream.
            const others = requested.filter((s) => !(ENV_SCOPES as readonly string[]).includes(s));
            ctx.query.scope = [...others, ...survivors].join(" ");
          }),
        },
      ],
      after: [
        {
          matcher: (ctx: { path: string }) => ctx.path === "/mcp/token",
          handler: createAuthMiddleware(async (ctx: any) => {
            const grantType = ctx.body?.grant_type;
            if (grantType !== "refresh_token") return;
            const returned = ctx.context.returned as { access_token?: string; scope?: string } | undefined;
            if (!returned?.access_token) return;

            const row = await ctx.context.adapter.findOne({
              model: "oauthAccessToken",
              where: [{ field: "accessToken", value: returned.access_token }],
            });
            if (!row) return;

            const current: string[] = String(row.scopes ?? "").split(" ").filter(Boolean);
            const currentEnv = current.filter((s) => (ENV_SCOPES as readonly string[]).includes(s));
            if (currentEnv.length === 0) return;

            const policy = await getClientPolicy(app, row.clientId);
            let allowed = currentEnv.filter((s) => policy.allowedScopes.includes(s));
            if (allowed.includes("env:live")) {
              const eligible = await hasApprovedLiveGrant(app, row.userId);
              if (!eligible) allowed = allowed.filter((s) => s !== "env:live");
            }

            const recomputed = [...current.filter((s) => !(ENV_SCOPES as readonly string[]).includes(s)), ...allowed].join(" ");
            if (recomputed === row.scopes) return;

            await ctx.context.adapter.update({
              model: "oauthAccessToken",
              where: [{ field: "accessToken", value: returned.access_token }],
              update: { scopes: recomputed },
            });
            ctx.context.returned = { ...returned, scope: recomputed };
          }),
        },
        {
          matcher: (ctx: { path: string }) => ctx.path === "/mcp/register",
          handler: createAuthMiddleware(async (ctx: any) => {
            const returned = ctx.context.returned;
            if (!(returned instanceof Response)) return;
            const body = await returned.clone().json();
            if (!body?.client_id) return;
            await upsertClientPolicy(app, body.client_id, body.client_name ?? null, ["env:dev", "env:live"]);
          }),
        },
      ],
    },
  };
}
