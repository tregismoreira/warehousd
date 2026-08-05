import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { preflight } from "../src/deploy/preflight";

// Mock child_process to control flyctl behavior
vi.mock("node:child_process");

describe("preflight", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wh-preflight-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("demo: true in YAML → refuses with demo-off check", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
demo: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
    });

    expect(result.ok).toBe(false);
    const demoCheck = result.checks.find((c) => c.id === "demo-off");
    expect(demoCheck).toBeDefined();
    expect(demoCheck?.ok).toBe(false);
    expect(demoCheck?.detail).toContain("demo: true");
  });

  it("demo: false in YAML but WAREHOUSD_DEMO=true in env → also refuses", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
demo: false
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const result = await preflight({
      projectDir,
      env: { WAREHOUSD_DEMO: "true" },
      allowLocalLogin: true,
    });

    expect(result.ok).toBe(false);
    const demoCheck = result.checks.find((c) => c.id === "demo-off");
    expect(demoCheck).toBeDefined();
    expect(demoCheck?.ok).toBe(false);
    expect(demoCheck?.detail).toContain("WAREHOUSD_DEMO=true");
  });

  // Same shape as --allow-local-login: deploying an unaudited environment is legitimate — that is
  // the whole point of the key — but never by omission. A deploy that silently drops the trail is
  // the one mistake nobody notices until they need the trail.
  it("audit.enabled: false in YAML → refuses with the audit-on check", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
audit: { enabled: false }
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const result = await preflight({ projectDir, env: {}, allowLocalLogin: true });

    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.id === "audit-on");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("--allow-disabled-audit");
  });

  it("audit.enabled: false with --allow-disabled-audit → the check passes", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
audit: { enabled: false }
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
      allowDisabledAudit: true,
    });

    const check = result.checks.find((c) => c.id === "audit-on");
    expect(check?.ok).toBe(true);
  });

  it("no audit key → the check passes without an override", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const result = await preflight({ projectDir, env: {}, allowLocalLogin: true });

    const check = result.checks.find((c) => c.id === "audit-on");
    expect(check?.ok).toBe(true);
  });

  it("two unresolved env refs → refuses and lists BOTH names in env-refs-resolve check", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
database:
  url: \${env:DB_URL}
server:
  port: 8722
  image: \${env:API_KEY}
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
    });

    expect(result.ok).toBe(false);
    const envCheck = result.checks.find((c) => c.id === "env-refs-resolve");
    expect(envCheck?.ok).toBe(false);
    expect(envCheck?.detail).toContain("API_KEY");
    expect(envCheck?.detail).toContain("DB_URL");
    // When env refs don't resolve, deploy-block and demo-off cannot be evaluated
    const deployCheck = result.checks.find((c) => c.id === "deploy-block-present");
    expect(deployCheck?.ok).toBe(false);
  });

  it("env ref ONLY in comment line → does NOT refuse", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
# url: \${env:COMMENTED_OUT_URL}
`,
    );

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
    });

    // docs/configuration.md ships a commented-out `# url: ${env:PROD_DATABASE_URL}`; treating it
    // as a live reference would refuse a deploy over a line that does nothing.
    const envCheck = result.checks.find((c) => c.id === "env-refs-resolve");
    expect(envCheck?.ok).toBe(true);
    expect(envCheck?.detail).not.toContain("COMMENTED_OUT_URL");
    // This fixture has no `deploy:` block, so the run still refuses overall — deliberately not
    // asserted as ok here. What matters is that the refusal is not about the commented ref.
    expect(result.checks.filter((c) => !c.ok).map((c) => c.id)).not.toContain("env-refs-resolve");
  });

  it("no SSO and allowLocalLogin: false → refuses", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
server:
  port: 8722
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: false,
    });

    expect(result.ok).toBe(false);
    const ssoCheck = result.checks.find((c) => c.id === "sso-or-local-login");
    expect(ssoCheck?.ok).toBe(false);
  });

  it("allowLocalLogin: true → sso-or-local-login passes", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
server:
  port: 8722
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
    });

    const ssoCheck = result.checks.find((c) => c.id === "sso-or-local-login");
    expect(ssoCheck?.ok).toBe(true);
    expect(ssoCheck?.detail).toContain("--allow-local-login");
  });

  it("SSO trio in env → sso-or-local-login passes even with allowLocalLogin: false", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
server:
  port: 8722
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");

    const result = await preflight({
      projectDir,
      env: {
        SSO_ISSUER: "https://example.com",
        SSO_CLIENT_ID: "client-id",
        SSO_CLIENT_SECRET: "client-secret",
      },
      allowLocalLogin: false,
    });

    const ssoCheck = result.checks.find((c) => c.id === "sso-or-local-login");
    expect(ssoCheck?.ok).toBe(true);
    expect(ssoCheck?.detail).toContain("SSO");
  });

  it("ssoLookup returning true with database.url → sso-or-local-login passes", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: my-app
  region: iad
  database:
    url: postgres://localhost/db
server:
  port: 8722
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const mockSsoLookup = vi.fn().mockResolvedValue(true);

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: false,
      ssoLookup: mockSsoLookup,
    });

    const ssoCheck = result.checks.find((c) => c.id === "sso-or-local-login");
    expect(ssoCheck?.ok).toBe(true);
    expect(mockSsoLookup).toHaveBeenCalledWith("postgres://localhost/db");
  });

  it("ssoLookup returning false → refuses, and points at all three ways out", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: my-app
  region: iad
  database:
    url: postgres://localhost/db
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: false,
      ssoLookup: vi.fn().mockResolvedValue(false),
    });

    const ssoCheck = result.checks.find((c) => c.id === "sso-or-local-login");
    expect(ssoCheck?.ok).toBe(false);
    expect(ssoCheck?.detail).toContain("--allow-local-login");
  });

  // A database that cannot be reached is not evidence that SSO is absent. Both refuse, but the
  // operator has to be able to tell "you have not set SSO up" from "I could not find out".
  it("distinguishes an unreachable database from a database with no provider", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: my-app
  region: iad
  database:
    url: postgres://localhost/db
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: false,
      ssoLookup: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:5432")),
    });

    const ssoCheck = result.checks.find((c) => c.id === "sso-or-local-login");
    expect(ssoCheck?.ok).toBe(false);
    expect(ssoCheck?.detail).toContain("could not check");
    expect(ssoCheck?.detail).toContain("ECONNREFUSED");
  });

  it("flyctl missing (ENOENT) → refuses with install instructions in detail", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
server:
  port: 8722
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    // Mock execFileSync to throw ENOENT
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
    });

    expect(result.ok).toBe(false);
    const flyCheck = result.checks.find((c) => c.id === "flyctl-ready");
    expect(flyCheck?.ok).toBe(false);
    expect(flyCheck?.detail).toContain("install");
  });

  it("multiple simultaneous failures → ALL appear in checks with count > 1", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
demo: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    // Mock execFileSync to throw auth error
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Not authenticated with flyctl. Run: flyctl auth login");
    });

    const result = await preflight({
      projectDir,
      env: { MISSING_VAR: "" }, // Still missing real env ref if there was one
      allowLocalLogin: false,
    });

    expect(result.ok).toBe(false);
    const failingChecks = result.checks.filter((c) => !c.ok);
    expect(failingChecks.length).toBeGreaterThan(1);
    // Should have demo-off and sso-or-local-login and flyctl-ready failing
    const ids = failingChecks.map((c) => c.id);
    expect(ids).toContain("demo-off");
    expect(ids).toContain("sso-or-local-login");
    expect(ids).toContain("flyctl-ready");
  });

  it("everything satisfied → ok: true", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
server:
  port: 8722
deploy:
  target: fly
  app_name: harbor-warehousd
  region: gru
  database:
    managed: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    // Mock execFileSync to succeed
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
    });

    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("no deploy block → deploy-block-present fails", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
server:
  port: 8722
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
    });

    const deployCheck = result.checks.find((c) => c.id === "deploy-block-present");
    expect(deployCheck?.ok).toBe(false);
    expect(deployCheck?.detail).toContain("deploy:");
  });

  it("deploy block present → deploy-block-present passes", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: my-app
  region: iad
  database:
    managed: true
server:
  port: 8722
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    // Mock execFileSync to succeed
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
    });

    const deployCheck = result.checks.find((c) => c.id === "deploy-block-present");
    expect(deployCheck?.ok).toBe(true);
  });

  it("all checks are present in every result", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
server:
  port: 8722
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");

    const result = await preflight({
      projectDir,
      env: {},
      allowLocalLogin: true,
    });

    const expectedIds = [
      "env-refs-resolve",
      "deploy-block-present",
      "demo-off",
      "audit-on",
      "schema-migrations-present",
      "sso-or-local-login",
      "flyctl-ready",
    ];
    const resultIds = result.checks.map((c) => c.id);
    expect(resultIds).toEqual(expectedIds);
  });

  // The database capability probe. Injected the same way ssoLookup is, so the wiring can be
  // exercised without a hosted Postgres on the other end.
  describe("database capabilities", () => {
    const withDeploy = (database: string) => `
project: test
server:
  port: 8722
deploy:
  target: fly
  app_name: my-app
  region: gru
  database:
${database}
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`;

    beforeEach(async () => {
      const { execFileSync } = await import("node:child_process");
      vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");
    });

    it("a refusal from the probe refuses the whole pre-flight", async () => {
      writeFileSync(
        join(projectDir, "warehousd.yml"),
        withDeploy(`    url: postgres://u:p@db.example.com:6543/postgres
    provider: supabase`),
      );

      const result = await preflight({
        projectDir,
        env: {},
        allowLocalLogin: true,
        dbCapabilities: () =>
          Promise.resolve([{ id: "db-provider", ok: false, detail: "pooler port 6543" }]),
      });

      expect(result.ok).toBe(false);
      expect(result.checks.find((c) => c.id === "db-provider")?.detail).toBe("pooler port 6543");
    });

    it("passes the configured provider and the postgres_fdw condition through", async () => {
      writeFileSync(
        join(projectDir, "warehousd.yml"),
        withDeploy(`    url: postgres://u:p@db.example.com:5432/postgres
    provider: neon`),
      );

      let seen: unknown;
      await preflight({
        projectDir,
        env: {},
        allowLocalLogin: true,
        dbCapabilities: (url, opts) => {
          seen = { url, opts };
          return Promise.resolve([]);
        },
      });

      expect(seen).toEqual({
        url: "postgres://u:p@db.example.com:5432/postgres",
        // No `sources:` in this config, so postgres_fdw is not demanded — a hosted Postgres that
        // forbids it must not be refused over a feature the project does not use.
        opts: { requireFdw: false, provider: "neon" },
      });
    });

    // Under `managed: true` the target has not provisioned anything yet, so there is nothing to
    // connect to and the checks could never pass. Same reasoning as sso-or-local-login.
    it("does not probe under database.managed", async () => {
      writeFileSync(join(projectDir, "warehousd.yml"), withDeploy(`    managed: true`));

      let called = false;
      const result = await preflight({
        projectDir,
        env: {},
        allowLocalLogin: true,
        dbCapabilities: () => {
          called = true;
          return Promise.resolve([]);
        },
      });

      expect(called).toBe(false);
      expect(result.checks.some((c) => c.id.startsWith("db-"))).toBe(false);
    });
  });
});
