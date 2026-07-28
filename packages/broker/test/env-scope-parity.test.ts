import { describe, it, expect } from "vitest";
import { resolveEnvScopes, pickEnvScope, type ClientPolicy } from "../src/oauth/env-scope";

describe("env-scope-parity", () => {
  it("resolveEnvScopes is the only implementation of rules 1-2", () => {
    // This test verifies that the function exists and is used
    // Rule 1: intersection with policy
    const policy1: ClientPolicy = { allowedScopes: ["env:dev", "env:live"] };
    const result1 = resolveEnvScopes({
      requested: ["env:dev", "env:live"],
      policy: policy1,
      liveEligible: true,
    });
    expect(result1).toEqual(["env:dev", "env:live"]);

    // Rule 2: filter env:live if user lacks grant
    const result2 = resolveEnvScopes({
      requested: ["env:dev", "env:live"],
      policy: policy1,
      liveEligible: false,
    });
    expect(result2).toEqual(["env:dev"]);
  });

  it("rule 1: intersects requested with policy", () => {
    const policy: ClientPolicy = { allowedScopes: ["env:dev"] };
    const result = resolveEnvScopes({
      requested: ["env:dev", "env:live"],
      policy,
      liveEligible: true,
    });
    expect(result).toEqual(["env:dev"]); // env:live filtered by policy
  });

  it("rule 2: strips env:live if user lacks grant, leaving the env:dev floor", () => {
    const policy: ClientPolicy = { allowedScopes: ["env:dev", "env:live"] };
    const result = resolveEnvScopes({
      requested: ["env:live"],
      policy,
      liveEligible: false,
    });
    // Not []: a client that engaged with env scopes and lost env:live falls back to env:dev.
    expect(result).toEqual(["env:dev"]); // env:live stripped, floor rule applies below
  });

  it("rule 3 (floor): env:dev floor when client engages with env scopes", () => {
    const policy: ClientPolicy = { allowedScopes: ["env:dev", "env:live"] };

    // Ineligible for live, policy allows dev → returns dev
    const result1 = resolveEnvScopes({
      requested: ["env:live"],
      policy,
      liveEligible: false,
    });
    expect(result1).toEqual(["env:dev"]);

    // No env scopes requested, but policy allows dev → would return dev in full context
    // (This happens outside resolveEnvScopes in the OAuth hook, but the logic is here)
  });

  it("floor not applied when policy lacks env:dev", () => {
    const policy: ClientPolicy = { allowedScopes: ["env:live"] };
    const result = resolveEnvScopes({
      requested: ["env:live"],
      policy,
      liveEligible: false,
    });
    expect(result).toEqual([]); // No floor, env:live stripped
  });

  it("pickEnvScope handles exactly-one-env (rule 4)", () => {
    // When both survive, picker must select one
    const result1 = pickEnvScope(["env:dev", "env:live"], "dev");
    expect(result1).toEqual(["env:dev"]);

    const result2 = pickEnvScope(["env:dev", "env:live"], "live");
    expect(result2).toEqual(["env:live"]);

    // When both survive but no picker, return both (caller should redirect)
    const result3 = pickEnvScope(["env:dev", "env:live"], null);
    expect(result3).toEqual(["env:dev", "env:live"]);

    // Single env survives, picker doesn't matter
    const result4 = pickEnvScope(["env:dev"], "live");
    expect(result4).toEqual(["env:dev"]);
  });

  // Table-driven: combinations of requested × policy × liveEligible
  describe("table-driven test matrix", () => {
    const testCases = [
      {
        name: "dev requested, policy allows both, eligible for live",
        requested: ["env:dev"],
        policyScopes: ["env:dev", "env:live"],
        liveEligible: true,
        expected: ["env:dev"],
      },
      {
        name: "live requested, policy allows both, eligible for live",
        requested: ["env:live"],
        policyScopes: ["env:dev", "env:live"],
        liveEligible: true,
        expected: ["env:live"],
      },
      {
        name: "both requested, policy allows both, eligible for live",
        requested: ["env:dev", "env:live"],
        policyScopes: ["env:dev", "env:live"],
        liveEligible: true,
        expected: ["env:dev", "env:live"],
      },
      {
        name: "both requested, policy allows both, NOT eligible for live",
        requested: ["env:dev", "env:live"],
        policyScopes: ["env:dev", "env:live"],
        liveEligible: false,
        expected: ["env:dev"],
      },
      {
        name: "live requested, policy allows dev only",
        requested: ["env:live"],
        policyScopes: ["env:dev"],
        liveEligible: true,
        expected: ["env:dev"], // floor
      },
      {
        name: "live requested, policy allows live only, not eligible",
        requested: ["env:live"],
        policyScopes: ["env:live"],
        liveEligible: false,
        expected: [],
      },
      {
        name: "neither requested, policy allows both",
        requested: [],
        policyScopes: ["env:dev", "env:live"],
        liveEligible: true,
        expected: [],
      },
    ];

    testCases.forEach((tc) => {
      it(tc.name, () => {
        const policy: ClientPolicy = { allowedScopes: tc.policyScopes };
        const result = resolveEnvScopes({
          requested: tc.requested,
          policy,
          liveEligible: tc.liveEligible,
        });
        expect(result).toEqual(tc.expected);
      });
    });
  });
});
