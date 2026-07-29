import { mcp } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { Pool } from "pg";
import { getClientPolicy, hasApprovedLiveGrant, upsertClientPolicy, DEFAULT_ORG_ID, resolveEnvScopes, recomputeEnvScope, pickEnvScope } from "@warehousd/broker";

const ENV_SCOPES = ["env:dev", "env:live"] as const;

// env:dev / env:live are the ONLY scopes this plugin adds beyond Better Auth's OIDC defaults
// (openid, profile, email, offline_access). Rule enforcement (client policy intersection,
// live-grant eligibility, exactly-one-env, refresh re-evaluation) is added in lib/oauth.ts's
// envScopePlugin — see Tasks 3-6.
export const mcpPlugin = mcp({
  loginPage: "/login",
  oidcConfig: {
    // Required by OIDCOptions as well as at the mcp() top level. Both are backstops only:
    // envScopePlugin's before-hook intercepts unauthenticated /mcp/authorize first (Task 3),
    // so Better Auth's own login redirect never fires for this endpoint.
    loginPage: "/login",
    scopes: ["env:dev", "env:live"],
    accessTokenExpiresIn: 900, // 15 min, per §6.1 rule 4
    allowDynamicClientRegistration: true,
  },
});

// §6.1 rules 1-4: delegate to resolveEnvScopes (packages/broker/src/oauth/env-scope.ts).
// Rules 1-2 narrow env scopes based on client policy and user's live grant eligibility.
// Rule 3 ensures exactly-one-env (via env-picker if needed).
// Rule 4 re-evaluates on token refresh.
//
// The three hook handlers below take `ctx: any` deliberately. The context type that
// createAuthMiddleware infers for its callback does not describe the fields these handlers
// legitimately read at runtime, so annotating them narrowly does not type-check: dropping
// the `: any` produces "ctx.query is possibly undefined" and "Property 'scopes' does not
// exist on type '{}'" against ctx.query / ctx.body / ctx.context.returned / ctx.context.adapter.
// Verified by removing the annotations and running tsc. Revisit if Better Auth ever exports
// a per-endpoint context type. (Unrelated to the `satisfies` at the end of this function,
// which addresses a different problem — see its own comment.)
export function envScopePlugin(app: Pool) {
  return {
    id: "env-scope",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/mcp/authorize",
          handler: createAuthMiddleware(async (ctx: any) => {
            // Intercept the unauthenticated case before Better Auth's authorize handler can arm its
            // `oidc_login_prompt` cookie-resume (better-auth/plugins/mcp/authorize.mjs sets the cookie;
            // mcp/index.mjs re-enters authorizeMCPOAuth from a `matcher: () => true` after-hook on ANY
            // response that sets a session cookie). That resume path never re-runs this hook, so §6.1
            // rules 1-3 would be skipped. Redirecting here means the browser always comes back to
            // /mcp/authorize WITH a session and the rules run exactly once, on the real request.
            const session = await getSessionFromCtx(ctx);
            if (!session) {
              const qs = ctx.request?.url?.split("?")[1] ?? "";
              throw ctx.redirect(`/login?${qs}`);
            }

            const clientId = String(ctx.query?.client_id ?? "");
            const requested = String(ctx.query?.scope ?? "").split(" ").filter(Boolean);
            const requestedEnv = requested.filter((s) => ["env:dev", "env:live"].includes(s));
            if (requestedEnv.length === 0) return;

            const policy = await getClientPolicy(app, clientId);
            const userId = session?.user?.id;
            const orgId = session?.user?.orgId ?? DEFAULT_ORG_ID;
            const liveEligible = userId ? await hasApprovedLiveGrant(app, userId, orgId) : false;

            // Resolve env scopes using rules 1-2
            let survivors = resolveEnvScopes({
              requested: requestedEnv,
              policy,
              liveEligible,
            });

            // Rule 3: exactly-one-env picker. When both env:dev and env:live survive,
            // redirect to the picker unless wh_env is set to a valid value.
            if (survivors.includes("env:dev") && survivors.includes("env:live")) {
              const picked = ctx.query?.wh_env;
              survivors = pickEnvScope(survivors, picked);
              if (survivors.length === 2) {
                // Still both; redirect to picker
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
            const others = requested.filter((s) => !["env:dev", "env:live"].includes(s));
            ctx.query.scope = [...others, ...survivors].join(" ");
          }),
        },
      ],
      after: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/mcp/token",
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
            const currentEnv = current.filter((s) => ["env:dev", "env:live"].includes(s));
            if (currentEnv.length === 0) return;

            // Re-derive from the CURRENT policy/grant state rather than narrowing from
            // currentEnv — a narrow-only recompute can never widen env:dev back up to
            // env:live after a promotion, since env:live was never in currentEnv to begin
            // with (it was already stripped at issuance). currentEnv.length===0 above is the
            // only gate: it preserves "never touch a token that never engaged with env scopes
            // at all," matching the before-hook's requestedEnv.length===0 gate.
            const policy = await getClientPolicy(app, row.clientId);
            const u = await app.query(`select "orgId" from app."user" where id=$1`, [row.userId]);
            const orgId = u.rows[0]?.orgId ?? DEFAULT_ORG_ID;
            const liveEligible = await hasApprovedLiveGrant(app, row.userId, orgId);

            // Re-derive rather than narrow — see recomputeEnvScope. Passing currentEnv as
            // `requested` would make a promotion permanently invisible to an existing token.
            const allowed = recomputeEnvScope({ policy, liveEligible });

            const recomputed = [...current.filter((s) => !["env:dev", "env:live"].includes(s)), ...allowed].join(" ");
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
          matcher: (ctx: { path?: string }) => ctx.path === "/mcp/register",
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
    // `satisfies` (not a plain literal) so this stays assignable to the plugins tuple in
    // lib/auth.ts. An unannotated literal degrades Better Auth's InferAPI across the whole
    // tuple, silently dropping later plugins' endpoints from `auth.api` — that is what hid
    // `registerSSOProvider` and broke `next build`.
  } satisfies BetterAuthPlugin;
}
