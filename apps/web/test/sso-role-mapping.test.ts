import { describe, it, expect } from "vitest";
import { ConfigSchema, type WarehousdConfig } from "@warehousd/broker";
import { roleForSsoUser } from "../lib/sso";

// JIT provisioning is the one login path that can hand out `admin` without a human deciding it,
// so the mapping from an IdP's groups to a warehousd role is tested on its own rather than only
// through a browser flow.
const base = {
  project: "t",
  server: { port: 1 },
  collections: {
    people: { description: "d", fields: { id: { type: "uuid", posture: "allow", pk: true } } },
  },
};

const withMapping = (provider: object): WarehousdConfig =>
  ConfigSchema.parse({ ...base, sso: { providers: { "keycloak-oidc": provider } } });

const cfg = withMapping({
  group_claim: "groups",
  groups: {
    "warehousd-admins": "admin",
    "warehousd-managers": "manager",
    everyone: "member",
  },
});

const plain: WarehousdConfig = ConfigSchema.parse(base);

describe("roleForSsoUser", () => {
  it("maps an asserted group to its configured role", () => {
    expect(roleForSsoUser(cfg, "keycloak-oidc", { groups: ["warehousd-managers"] })).toBe(
      "manager",
    );
    expect(roleForSsoUser(cfg, "keycloak-oidc", { groups: ["warehousd-admins"] })).toBe("admin");
  });

  // Taking the lowest would make joining a second group a demotion, which is not what an operator
  // writing "admins → admin" means by it.
  it("takes the highest role when several groups map", () => {
    expect(
      roleForSsoUser(cfg, "keycloak-oidc", {
        groups: ["everyone", "warehousd-admins", "warehousd-managers"],
      }),
    ).toBe("admin");
  });

  it("ignores groups the map does not name", () => {
    expect(
      roleForSsoUser(cfg, "keycloak-oidc", { groups: ["hr", "printer-access", "everyone"] }),
    ).toBe("member");
  });

  it("accepts a bare string for an IdP that sends one group unwrapped", () => {
    expect(roleForSsoUser(cfg, "keycloak-oidc", { groups: "warehousd-admins" })).toBe("admin");
  });

  // An IdP that stops sending the claim must not promote anyone — and must not lock the login out
  // either, which is why the answer is a role rather than a refusal.
  it("falls back to default_role when the claim is missing, empty or the wrong shape", () => {
    for (const userInfo of [{}, { groups: [] }, { groups: 42 }, { groups: null }, { groups: {} }])
      expect(roleForSsoUser(cfg, "keycloak-oidc", userInfo)).toBe("member");
  });

  it("honours a default_role other than member", () => {
    const c = withMapping({
      group_claim: "groups",
      groups: { "warehousd-admins": "admin" },
      default_role: "manager",
    });
    expect(roleForSsoUser(c, "keycloak-oidc", { groups: ["hr"] })).toBe("manager");
    expect(roleForSsoUser(c, "keycloak-oidc", { groups: ["warehousd-admins"] })).toBe("admin");
  });

  it("reads the claim the provider names, not a fixed one", () => {
    const c = withMapping({ group_claim: "roles", groups: { "wh-admin": "admin" } });
    expect(roleForSsoUser(c, "keycloak-oidc", { roles: ["wh-admin"] })).toBe("admin");
    // The same value under the wrong key buys nothing.
    expect(roleForSsoUser(c, "keycloak-oidc", { groups: ["wh-admin"] })).toBe("member");
  });

  // The mapping is per provider, so a second IdP registered later cannot inherit the first's.
  it("applies nothing to a provider with no mapping configured", () => {
    expect(roleForSsoUser(cfg, "okta-oidc", { groups: ["warehousd-admins"] })).toBe("member");
  });

  it("leaves a deployment with no sso config exactly where it was: member", () => {
    expect(roleForSsoUser(plain, "keycloak-oidc", { groups: ["warehousd-admins"] })).toBe("member");
  });

  // A group named after an Object.prototype key must not resolve through the prototype chain —
  // the same class of bug findCollection closed for collection names.
  it("does not resolve a group through the prototype chain", () => {
    expect(roleForSsoUser(cfg, "keycloak-oidc", { groups: ["constructor", "toString"] })).toBe(
      "member",
    );
  });
});

describe("the group map in the config schema", () => {
  it("refuses a role that is not one of the three", () => {
    expect(() =>
      withMapping({ group_claim: "groups", groups: { "wh-admins": "superuser" } }),
    ).toThrow();
  });

  it("refuses a provider with no group_claim", () => {
    expect(() => withMapping({ groups: { "wh-admins": "admin" } })).toThrow();
  });

  it("refuses an empty group_claim, which would read every user's undefined", () => {
    expect(() => withMapping({ group_claim: "", groups: {} })).toThrow();
  });

  // Strict, like every other object in the config: an unrecognised key here is a typo that would
  // otherwise read as a policy silently doing nothing.
  it("refuses an unrecognised key", () => {
    expect(() =>
      withMapping({ group_claim: "groups", groups: {}, defualt_role: "admin" }),
    ).toThrow();
  });
});
