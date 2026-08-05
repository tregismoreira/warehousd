import { describe, it, expect } from "vitest";
import {
  dbProviders,
  detectProvider,
  resolveProvider,
  DB_PROVIDER_IDS,
  type DbProvider,
} from "../src/index";

const roleOf = (url: string, role = "warehousd_dev") =>
  detectProvider(url).roleUsername(new URL(url), role);

// The target registry is tied to its id list by `satisfies Record<DeployTargetId, DeployTarget>`,
// which the provider registry cannot be: `dbProviders` is what *derives* DbProviderId, and
// `DbProvider.id` is a plain string. So `{ neon: { id: "railway", … } }` compiles, `DB_PROVIDER_IDS`
// still reads "neon", and `resolveProvider(url, "neon")` hands back Railway's module — role names
// derived by the wrong provider, with nothing in the type system to say so.
describe("the provider registry", () => {
  it("registers exactly the ids DeploySchema accepts", () => {
    expect(Object.keys(dbProviders).sort()).toEqual([...DB_PROVIDER_IDS].sort());
  });

  it("every registered provider answers to its own key", () => {
    for (const id of DB_PROVIDER_IDS) {
      expect(dbProviders[id].id).toBe(id);
      expect(dbProviders[id].label.length).toBeGreaterThan(0);
    }
  });
});

describe("detectProvider", () => {
  it("picks supabase for the direct host and the pooler", () => {
    expect(
      detectProvider("postgres://postgres:pw@db.abcdefghij.supabase.co:5432/postgres").id,
    ).toBe("supabase");
    expect(
      detectProvider(
        "postgres://postgres.abcdefghij:pw@aws-0-sa-east-1.pooler.supabase.com:5432/postgres",
      ).id,
    ).toBe("supabase");
  });

  it("picks neon and railway from their hosts", () => {
    expect(detectProvider("postgres://u:p@ep-cool-1.eu-central-1.aws.neon.tech/neondb").id).toBe(
      "neon",
    );
    expect(
      detectProvider("postgres://postgres:p@containers-us-west-1.railway.app:6001/railway").id,
    ).toBe("railway");
    expect(detectProvider("postgres://postgres:p@roundhouse.proxy.rlwy.net:41234/railway").id).toBe(
      "railway",
    );
  });

  // The fallback is the whole compatibility promise: an unrecognised host must behave exactly as
  // every host did before this registry existed.
  it("falls back to generic for an unknown host", () => {
    expect(detectProvider("postgres://user:pw@db.internal.example.com:5432/warehousd").id).toBe(
      "generic",
    );
  });

  it("falls back to generic rather than throwing on an unparseable url", () => {
    expect(detectProvider("host=localhost user=postgres").id).toBe("generic");
    expect(detectProvider("").id).toBe("generic");
  });

  // generic.matches is true for everything, so a scan that trusted key order would return it for
  // a Supabase url the moment someone reordered the registry literal.
  it("never returns generic for a host another provider claims", () => {
    for (const id of DB_PROVIDER_IDS) {
      if (id === "generic") continue;
      expect(dbProviders[id].matches(new URL("postgres://u:p@db.internal.example.com/x"))).toBe(
        false,
      );
    }
  });
});

describe("roleUsername", () => {
  it("supabase pooler: keeps the project ref the username carries", () => {
    // Supavisor routes on the username, so a bare `warehousd_dev` names no project and
    // authenticates as nobody.
    expect(
      roleOf("postgres://postgres.abcdefghij:pw@aws-0-sa-east-1.pooler.supabase.com:5432/postgres"),
    ).toBe("warehousd_dev.abcdefghij");
  });

  it("supabase direct: the plain role name is correct", () => {
    expect(roleOf("postgres://postgres:pw@db.abcdefghij.supabase.co:5432/postgres")).toBe(
      "warehousd_dev",
    );
  });

  it("supabase: a dotless username on the pooler host is left alone", () => {
    expect(roleOf("postgres://postgres:pw@aws-0-sa-east-1.pooler.supabase.com:5432/postgres")).toBe(
      "warehousd_dev",
    );
  });

  it("neon, railway and generic all use the plain role name", () => {
    expect(roleOf("postgres://neondb_owner:p@ep-cool-1.eu-central-1.aws.neon.tech/neondb")).toBe(
      "warehousd_dev",
    );
    expect(roleOf("postgres://postgres:p@roundhouse.proxy.rlwy.net:41234/railway")).toBe(
      "warehousd_dev",
    );
    expect(roleOf("postgres://owner:p@db.example.com:5432/warehousd", "warehousd_live_write")).toBe(
      "warehousd_live_write",
    );
  });
});

describe("resolveProvider", () => {
  it("an explicit id beats the host", () => {
    const url = "postgres://postgres.abcdefghij:pw@pg.example.com:5432/postgres";
    expect(resolveProvider(url).id).toBe("generic");
    expect(resolveProvider(url, "supabase").id).toBe("supabase");
    expect(resolveProvider(url, "supabase").roleUsername(new URL(url), "warehousd_dev")).toBe(
      "warehousd_dev.abcdefghij",
    );
  });
});

describe("provider checks", () => {
  const run = async (provider: DbProvider, url: string) => {
    if (!provider.checks) throw new Error(`${provider.id} declares no checks`);
    return provider.checks(new URL(url), null);
  };

  it("supabase refuses the transaction pooler and names why", async () => {
    const checks = await run(
      dbProviders.supabase,
      "postgres://postgres.abcdefghij:pw@aws-0-sa-east-1.pooler.supabase.com:6543/postgres",
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toContain("6543");
    expect(checks[0]?.detail).toContain("startup parameters");
  });

  it("supabase accepts the session pooler and the direct connection", async () => {
    for (const url of [
      "postgres://postgres.abcdefghij:pw@aws-0-sa-east-1.pooler.supabase.com:5432/postgres",
      "postgres://postgres:pw@db.abcdefghij.supabase.co:5432/postgres",
    ]) {
      const checks = await run(dbProviders.supabase, url);
      expect(checks[0]?.ok).toBe(true);
    }
  });

  it("neon advises sslmode=require without refusing", async () => {
    const host = "postgres://u:p@ep-cool-1.eu-central-1.aws.neon.tech/neondb";
    const without = await run(dbProviders.neon, host);
    expect(without[0]?.ok).toBe(true);
    expect(without[0]?.detail).toContain("sslmode");

    const withIt = await run(dbProviders.neon, `${host}?sslmode=require`);
    expect(withIt[0]?.detail).toContain("sslmode=require");
  });

  it("railway and generic have nothing provider-specific to say", () => {
    expect(dbProviders.railway).not.toHaveProperty("checks");
    expect(dbProviders.generic).not.toHaveProperty("checks");
  });
});
