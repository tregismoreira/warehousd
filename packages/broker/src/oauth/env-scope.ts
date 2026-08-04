// Extracted env-scope rules from apps/web/lib/oauth.ts §6.1 rules 1-4.
// This is the ONLY implementation: both OAuth tokens and API keys must use this
// function to ensure they cannot drift apart on which envs are reachable.

const ENV_SCOPES = ["env:dev", "env:live"] as const;

export type ClientPolicy = {
  allowedScopes: string[];
};

export function resolveEnvScopes(options: {
  requested: string[]; // scopes requested in the auth flow
  policy: ClientPolicy; // client's allowed scopes (policy.allowedScopes)
  liveEligible: boolean; // user has an approved live grant
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

// The same rules, for a caller that must end up with exactly one env or refuse.
//
// resolveEnvScopes returns [] for a request that named no env scope, which is right for the OAuth
// authorize hook — it means "leave this token's scopes alone". It was wrong for /v1/token, which
// mints the token itself: an empty scope string was stored, and both context constructors read a
// missing env as dev. So omitting `scope` produced a working dev token no matter what the client
// policy allowed, and the policy's env list was not the gate it is documented to be.
//
// Absence is treated as asking for the floor, not as asking for nothing. That keeps a client that
// never sent a scope working, while making the env it gets an explicit property of the token
// rather than a default applied later by whoever happens to read it.
export function resolveIssuedEnvScope(options: {
  requested: string[];
  policy: ClientPolicy;
  liveEligible: boolean;
}): "env:dev" | "env:live" | null {
  const { requested, policy, liveEligible } = options;
  const requestedEnv = requested.filter((s) => (ENV_SCOPES as readonly string[]).includes(s));
  const survivors =
    requestedEnv.length === 0
      ? recomputeEnvScope({ policy, liveEligible })
      : resolveEnvScopes({ requested, policy, liveEligible });

  // Exactly one, and live wins only if it survived the rules above. A client whose policy allows
  // neither env gets null, and the caller refuses rather than falling back to dev.
  if (survivors.includes("env:live")) return "env:live";
  if (survivors.includes("env:dev")) return "env:dev";
  return null;
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

// The env encoded in an API key's own prefix, applied to the client policy as a ceiling.
//
// It only ever narrows. A `whd_dev_` key drops `env:live` from the effective policy, so a key
// minted for dev cannot reach real data however the policy is widened afterwards — the property
// the prefix claims by being visible on the key. A `whd_live_` key removes nothing: live is the
// top of the axis, and stripping `env:dev` would stop a live key being used against generated
// data for no gain. Nothing here ADDS a scope: a live-prefixed key whose policy allows only
// `env:dev` still gets dev, and the user's live-grant eligibility is still checked separately.
export function narrowPolicyToKeyEnv<P extends ClientPolicy>(policy: P, keyEnv: "dev" | "live"): P {
  if (keyEnv === "live") return policy;
  return { ...policy, allowedScopes: policy.allowedScopes.filter((s) => s !== "env:live") };
}

// Policy intersection for dual-mode (both dev and live eligible).
// Used by the env-picker UI to enforce exactly-one-env selection.
export function pickEnvScope(survivors: string[], picked: string | null | undefined): string[] {
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
