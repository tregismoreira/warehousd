import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { loadConfig } from "@warehousd/broker";
import { buildDeployOutputs, formatDeployOutputs } from "../src/deploy/outputs";
import { writeDeployOutputs, readDeployOutputs } from "../src/state";

describe("buildDeployOutputs", () => {
  const cfg = {
    project: "test-app",
    server: { port: 8722 },
    collections: {},
  } as any;

  it("mcpUrl is the target base URL plus /mcp", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.mcpUrl).toMatch(/^https:\/\/myapp\.fly\.dev\/mcp$/);
  });

  it("apiUrl is the target base URL", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.apiUrl).toMatch(/^https:\/\/myapp\.fly\.dev$/);
  });

  it("adminUrl is the target base URL plus /admin", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.adminUrl).toMatch(/^https:\/\/myapp\.fly\.dev\/admin$/);
  });

  it("databaseUrl is null under managed Postgres", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.databaseUrl).toBeNull();
  });

  it("databaseUrl is echoed when supplied", () => {
    const dbUrl = "postgres://user:pass@prod.example.com/db";
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: dbUrl,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.databaseUrl).toBe(dbUrl);
  });

  it("env is always dev", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.env).toBe("dev");
  });

  it("deployedAt is an ISO string of the provided date", () => {
    const date = new Date("2025-01-15T12:34:56.789Z");
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: date,
    });
    expect(outputs.deployedAt).toBe("2025-01-15T12:34:56.789Z");
  });

  it("configSnapshot is a reference to the config", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.configSnapshot).toBe(cfg);
  });
});

// The label and the hint reach the panel from the target, so the summary of a Railway deploy does
// not offer `fly postgres connect`. Here it is Fly's, which is what these assertions are about.
const FLY = { label: "Fly.io", databaseHint: "managed by Fly Postgres — `fly postgres connect`" };

describe("formatDeployOutputs", () => {
  const cfg = {
    project: "test-app",
    server: { port: 8722 },
    collections: {},
  } as any;

  it("contains the mcpUrl", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const formatted = formatDeployOutputs(outputs, {
      adminEmail: "admin@example.com",
      adminPassword: "secret123",
      target: FLY,
    });
    expect(formatted).toContain("https://myapp.fly.dev/mcp");
  });

  // Was "contains the admin password". It deliberately no longer does: the panel is what ends up
  // in scrollback and in screen shares, so the plaintext is masked there and reachable through
  // `warehousd secrets --show` or `--json` instead.
  it("masks the admin password, and shows it only when asked", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const masked = formatDeployOutputs(outputs, {
      adminEmail: "admin@example.com",
      adminPassword: "mysecretpassword",
      target: FLY,
    });
    expect(masked).not.toContain("mysecretpassword");
    expect(masked).toContain("myse...word");

    const shown = formatDeployOutputs(
      outputs,
      { adminEmail: "admin@example.com", adminPassword: "mysecretpassword", target: FLY },
      { showSecrets: true },
    );
    expect(shown).toContain("mysecretpassword");
  });

  it("prints the target's own database hint when databaseUrl is null", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const formatted = formatDeployOutputs(outputs, {
      adminEmail: "admin@example.com",
      adminPassword: "secret123",
      target: FLY,
    });
    expect(formatted).toContain("fly postgres connect");
  });

  // The panel is the last thing a deploy prints, and it used to be titled "warehousd deployed to
  // Fly" and to answer `fly postgres connect` whatever it had just deployed to — which was true of
  // the only target there was, and wrong the moment there were two.
  it("names no target it did not deploy to", () => {
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.up.railway.app",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const formatted = formatDeployOutputs(outputs, {
      adminEmail: "admin@example.com",
      adminPassword: "secret123",
      target: {
        label: "Railway",
        databaseHint: "managed by Railway Postgres — `railway connect Postgres`",
      },
    });
    expect(formatted).toContain("deployed to Railway");
    expect(formatted).toContain("railway connect Postgres");
    expect(formatted.toLowerCase()).not.toContain("fly");
  });

  it("includes the database URL, with only its password masked", () => {
    const dbUrl = "postgres://user:supersecretpassword@prod.example.com/db";
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: dbUrl,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const formatted = formatDeployOutputs(outputs, {
      adminEmail: "admin@example.com",
      adminPassword: "secret123",
      target: FLY,
    });
    // Host, user and database name are the reason anyone reads this line; the credential is not.
    expect(formatted).toContain("prod.example.com/db");
    expect(formatted).toContain("postgres://user:");
    expect(formatted).not.toContain("supersecretpassword");

    expect(
      formatDeployOutputs(
        outputs,
        { adminEmail: "admin@example.com", adminPassword: "secret123", target: FLY },
        { showSecrets: true },
      ),
    ).toContain(dbUrl);
  });
});

describe("writeDeployOutputs and readDeployOutputs", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wh-deploy-outputs-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("writeDeployOutputs writes to .warehousd/outputs.deploy.json", () => {
    const cfg = {
      project: "test",
      server: { port: 8722 },
      collections: {},
    } as any;
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    writeDeployOutputs(projectDir, outputs);
    const path = join(projectDir, ".warehousd", "outputs.deploy.json");
    expect(existsSync(path)).toBe(true);
  });

  it("writeDeployOutputs creates file with mode 0600", () => {
    const cfg = {
      project: "test",
      server: { port: 8722 },
      collections: {},
    } as any;
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    writeDeployOutputs(projectDir, outputs);
    const path = join(projectDir, ".warehousd", "outputs.deploy.json");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("readDeployOutputs round-trips written outputs", () => {
    const cfg = {
      project: "test",
      server: { port: 8722 },
      collections: {},
    } as any;
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: "postgres://localhost/test",
      now: new Date("2025-01-01T00:00:00Z"),
    });
    writeDeployOutputs(projectDir, outputs);
    const read = readDeployOutputs(projectDir);
    expect(read).toEqual(outputs);
  });

  it("readDeployOutputs returns null when file is absent", () => {
    const read = readDeployOutputs(projectDir);
    expect(read).toBeNull();
  });

  it("configSnapshot survives the round trip", () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const cfg = loadConfig(join(__dirname, "..", "..", "..", "examples", "harbor"));
    const outputs = buildDeployOutputs({
      baseUrl: "https://myapp.fly.dev",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    writeDeployOutputs(projectDir, outputs);
    const read = readDeployOutputs(projectDir);
    expect(read?.configSnapshot).toEqual(cfg);
  });
});
