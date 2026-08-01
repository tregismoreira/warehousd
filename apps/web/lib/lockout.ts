import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import type { Pool } from "pg";

export const MAX_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;

/**
 * Per-account lockout on local credentials.
 *
 * lib/rate-limit.ts caps cost per caller: Better Auth throttles `/api/auth/*` per IP, and
 * `/v1/token` is capped per client id. Neither counts failures against an *account*, so a guess
 * spread thinly across addresses — which is what a password-spraying botnet is — never trips
 * either. This counts per account and refuses the account outright once the threshold is crossed,
 * including for the correct password: the point is to make the account unusable to the guesser,
 * and a lock that the right password walks through protects nothing.
 *
 * The refusal is identical whether or not the account exists, and attempts against addresses that
 * do not exist are recorded too (see migration 0002), so the lock cannot be used to enumerate.
 */
export function lockoutPlugin(app: Pool) {
  return {
    id: "local-credential-lockout",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const email = String(ctx.body?.email ?? "").toLowerCase();
            if (!email) return;
            const { rows } = await app.query(
              `select 1 from app.login_attempts where email = $1 and locked_until > now()`,
              [email],
            );
            if (rows.length > 0) {
              throw new APIError("TOO_MANY_REQUESTS", {
                message: "Too many failed attempts. Try again later.",
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const email = String(ctx.body?.email ?? "").toLowerCase();
            if (!email) return;

            // Better Auth surfaces a failed sign-in on ctx.context.returned rather than throwing
            // past the after-hook, so success and failure both arrive here.
            const returned: unknown = ctx.context.returned;
            const failed =
              returned instanceof APIError ||
              (returned instanceof Response && returned.status >= 400);

            if (!failed) {
              await app.query(`delete from app.login_attempts where email = $1`, [email]);
              return;
            }

            // locked_until is only stamped on the attempt that crosses the threshold, and left
            // alone afterwards: recomputing it on every later failure would let an attacker who
            // keeps guessing hold a locked account locked forever, turning the control into a
            // denial of service against the real owner.
            await app.query(
              `insert into app.login_attempts (email, failures, last_failure_at)
               values ($1, 1, now())
               on conflict (email) do update set
                 failures = app.login_attempts.failures + 1,
                 last_failure_at = now(),
                 locked_until = case
                   when app.login_attempts.failures + 1 >= $2
                   then now() + ($3 || ' minutes')::interval
                   else app.login_attempts.locked_until end`,
              [email, MAX_FAILURES, String(LOCKOUT_MINUTES)],
            );
          }),
        },
      ],
    },
    // See the matching note in lib/oauth.ts and lib/sso.ts: `satisfies` keeps Better Auth's
    // InferAPI intact across the plugins tuple in lib/auth.ts. Without it the tuple degrades to
    // a plain array and every *other* plugin's endpoints vanish from the inferred api type —
    // which surfaces far away, as "registerSSOProvider does not exist".
  } satisfies BetterAuthPlugin;
}
