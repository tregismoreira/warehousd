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

  it("mcpUrl starts with https and embeds the appName", () => {
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.mcpUrl).toMatch(/^https:\/\/myapp\.fly\.dev\/mcp$/);
  });

  it("apiUrl starts with https and embeds the appName", () => {
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.apiUrl).toMatch(/^https:\/\/myapp\.fly\.dev$/);
  });

  it("adminUrl starts with https and embeds the appName", () => {
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.adminUrl).toMatch(/^https:\/\/myapp\.fly\.dev\/admin$/);
  });

  it("databaseUrl is null under managed Postgres", () => {
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.databaseUrl).toBeNull();
  });

  it("databaseUrl is echoed when supplied", () => {
    const dbUrl = "postgres://user:pass@prod.example.com/db";
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: dbUrl,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.databaseUrl).toBe(dbUrl);
  });

  it("env is always dev", () => {
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.env).toBe("dev");
  });

  it("deployedAt is an ISO string of the provided date", () => {
    const date = new Date("2025-01-15T12:34:56.789Z");
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: date,
    });
    expect(outputs.deployedAt).toBe("2025-01-15T12:34:56.789Z");
  });

  it("configSnapshot is a reference to the config", () => {
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(outputs.configSnapshot).toBe(cfg);
  });
});

describe("formatDeployOutputs", () => {
  const cfg = {
    project: "test-app",
    server: { port: 8722 },
    collections: {},
  } as any;

  it("contains the mcpUrl", () => {
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const formatted = formatDeployOutputs(outputs, {
      adminEmail: "admin@example.com",
      adminPassword: "secret123",
    });
    expect(formatted).toContain("https://myapp.fly.dev/mcp");
  });

  it("contains the admin password", () => {
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const formatted = formatDeployOutputs(outputs, {
      adminEmail: "admin@example.com",
      adminPassword: "mysecretpassword",
    });
    expect(formatted).toContain("mysecretpassword");
  });

  it("mentions fly postgres connect when databaseUrl is null", () => {
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const formatted = formatDeployOutputs(outputs, {
      adminEmail: "admin@example.com",
      adminPassword: "secret123",
    });
    expect(formatted).toContain("fly postgres connect");
  });

  it("includes the database URL when provided", () => {
    const dbUrl = "postgres://user:pass@prod.example.com/db";
    const outputs = buildDeployOutputs({
      appName: "myapp",
      cfg,
      databaseUrl: dbUrl,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const formatted = formatDeployOutputs(outputs, {
      adminEmail: "admin@example.com",
      adminPassword: "secret123",
    });
    expect(formatted).toContain(dbUrl);
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
      appName: "myapp",
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
      appName: "myapp",
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
      appName: "myapp",
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
      appName: "myapp",
      cfg,
      databaseUrl: null,
      now: new Date("2025-01-01T00:00:00Z"),
    });
    writeDeployOutputs(projectDir, outputs);
    const read = readDeployOutputs(projectDir);
    expect(read?.configSnapshot).toEqual(cfg);
  });
});
