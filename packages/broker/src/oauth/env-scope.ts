// Extracted env-scope rules from apps/web/lib/oauth.ts §6.1 rules 1-4.
// This is the ONLY implementation: both OAuth tokens and API keys must use this
// function to ensure they cannot drift apart on which envs are reachable.

const ENV_SCOPES = ["env:dev", "env:live"] as const;

export type ClientPolicy = {
  allowedScopes: string[];
};

export function resolveEnvScopes(options: {
  requested: string[];          // scopes requested in the auth flow
  policy: ClientPolicy;          // client's allowed scopes (policy.allowedScopes)
  liveEligible: boolean;         // user has an approved live grant
}): string[] {
  const { requested, policy, liveEligible } = options;

  // A caller that never asked for an env scope is left entirely alone — no floor, no
  // additions. This mirrors the `requestedEnv.length === 0` early return the inline hooks
  // had: never touch a token that never engaged with env scopes at all.
  const requestedEnv = requested.filter((s) => (ENV_SCOPES as readonly string[]).includes(s));
  if (requestedEnv.length === 0) return [];

  // Rule 1: intersect the request with the client's policy. Escalation is impossible by
  // construction rather than by after-the-fact validation.
  let survivors = requestedEnv.filter((s) => policy.allowedScopes.includes(s));

  // Rule 2: env:live additionally requires the USER to be eligible — at least one approved,
  // unexpired live grant — even for a live-allowed client.
  if (survivors.includes("env:live") && !liveEligible) {
    survivors = survivors.filter((s) => s !== "env:live");
  }

  // Rule 3: once a client has engaged with env scopes at all, env:dev is the floor. "A client
  // whose policy lacks env:live can request anything it wants — it will only ever receive
  // env:dev", not nothing.
  if (survivors.length === 0 && policy.allowedScopes.includes("env:dev")) {
    survivors = ["env:dev"];
  }

  return survivors;
}

// Rule 4, the refresh path. It re-derives from the CURRENT policy and eligibility rather than
// narrowing the scopes the token already has — a narrow-only recompute could never widen
// env:dev back up to env:live after a promotion, because env:live was stripped at issuance and
// so was never in the set to survive an intersection. Issuance answers "what may this request
// have"; refresh answers "what may this user have now", and they are not the same question.
//
// Callers gate on the token having engaged with env scopes at all; a token carrying none is
// left untouched, matching resolveEnvScopes' early return.
export function recomputeEnvScope(options: {
  policy: ClientPolicy;
  liveEligible: boolean;
}): string[] {
  const { policy, liveEligible } = options;
  if (liveEligible && policy.allowedScopes.includes("env:live")) return ["env:live"];
  if (policy.allowedScopes.includes("env:dev")) return ["env:dev"];
  return [];
}

// Policy intersection for dual-mode (both dev and live eligible).
// Used by the env-picker UI to enforce exactly-one-env selection.
export function pickEnvScope(
  survivors: string[],
  picked: string | null | undefined,
): string[] {
  // Rule 4: exactly-one-env picker. When both env:dev and env:live survive
  // rules 1-3, the caller (UI or API) must pick one.
  if (survivors.includes("env:dev") && survivors.includes("env:live")) {
    if (picked === "dev" || picked === "live") {
      return [`env:${picked}`];
    }
    // Return both; caller should redirect to picker if neither picked is present
    return survivors;
  }
  return survivors;
}
