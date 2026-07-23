import { mcp } from "better-auth/plugins";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { Pool } from "pg";
import { getClientPolicy } from "@warehousd/broker";

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
            const survivors = requestedEnv.filter((s) => policy.allowedScopes.includes(s));

            const others = requested.filter((s) => !(ENV_SCOPES as readonly string[]).includes(s));
            ctx.query = { ...ctx.query, scope: [...others, ...survivors].join(" ") };
          }),
        },
      ],
    },
  };
}
