import { describe, it, expect } from "vitest";
import {
  narrowPolicyToKeyEnv,
  resolveIssuedEnvScope,
  type ClientPolicy,
} from "../src/oauth/env-scope";
import { generateSecret, envFromSecret, validateSecretFormat } from "../src/credentials/keys";

// The `whd_dev_` / `whd_live_` prefix as a ceiling rather than a label.
//
// The prefix is printed on the key and shown wherever a key is listed, so it is what an operator
// reasons about when a key leaks. That reasoning is only sound if the prefix actually bounds what
// the key can reach — which is what narrowPolicyToKeyEnv makes true, by striking `env:live` from
// the policy before any scope is resolved.
const both: ClientPolicy = { allowedScopes: ["env:dev", "env:live"] };
const devOnly: ClientPolicy = { allowedScopes: ["env:dev"] };

describe("narrowPolicyToKeyEnv", () => {
  it("strikes env:live from the policy for a dev-prefixed key", () => {
    expect(narrowPolicyToKeyEnv(both, "dev").allowedScopes).toEqual(["env:dev"]);
  });

  it("leaves a live-prefixed key's policy alone: live is the top of the axis", () => {
    expect(narrowPolicyToKeyEnv(both, "live").allowedScopes).toEqual(["env:dev", "env:live"]);
  });

  // Only ever narrows. A live prefix on a key whose policy allows only dev adds nothing.
  it("never adds a scope the policy withholds", () => {
    expect(narrowPolicyToKeyEnv(devOnly, "live").allowedScopes).toEqual(["env:dev"]);
  });

  it("does not strip env:dev from a live key, which would make it useless against synthetic data", () => {
    expect(narrowPolicyToKeyEnv(both, "live").allowedScopes).toContain("env:dev");
  });

  it("leaves the rest of the policy intact", () => {
    const policy = { allowedScopes: ["env:dev", "env:live"], mode: "headless" };
    expect(narrowPolicyToKeyEnv(policy, "dev")).toEqual({
      allowedScopes: ["env:dev"],
      mode: "headless",
    });
  });
});

describe("the env a token is issued for, through the ceiling", () => {
  const issue = (keyEnv: "dev" | "live", requested: string[], liveEligible: boolean) =>
    resolveIssuedEnvScope({
      requested,
      policy: narrowPolicyToKeyEnv(both, keyEnv),
      liveEligible,
    });

  // The whole point: no combination of policy, request and eligibility gets a dev-prefixed key
  // to live. The policy here is the widest one that exists.
  it("a dev-prefixed key can never yield env:live", () => {
    expect(issue("dev", ["env:live"], true)).toBe("env:dev");
    expect(issue("dev", ["env:dev", "env:live"], true)).toBe("env:dev");
    expect(issue("dev", [], true)).toBe("env:dev");
  });

  it("a live-prefixed key reaches live when the user is eligible", () => {
    expect(issue("live", ["env:live"], true)).toBe("env:live");
  });

  // The prefix removes a gate, it does not replace the others.
  it("a live-prefixed key is still refused live without an approved live grant", () => {
    expect(issue("live", ["env:live"], false)).toBe("env:dev");
  });

  it("a live-prefixed key is still bounded by a dev-only policy", () => {
    expect(
      resolveIssuedEnvScope({
        requested: ["env:live"],
        policy: narrowPolicyToKeyEnv(devOnly, "live"),
        liveEligible: true,
      }),
    ).toBe("env:dev");
  });
});

describe("the prefix a key carries", () => {
  it("round-trips both environments through a well-formed secret", () => {
    for (const env of ["dev", "live"] as const) {
      const secret = generateSecret(env, "abc123");
      expect(validateSecretFormat(secret)).toBe(true);
      expect(secret.startsWith(`whd_${env}_`)).toBe(true);
      expect(envFromSecret(secret)).toBe(env);
    }
  });
});
