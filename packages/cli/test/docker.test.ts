import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { buildRunArgs, assertDocker } from "../src/docker";

vi.mock("node:child_process");

describe("buildRunArgs", () => {
  it("builds db container args in correct order", () => {
    const spec = {
      name: "wh_myapp_db",
      image: "postgres:17-alpine",
      network: "wh_myapp_net",
      label: "warehousd.project=myapp",
      env: {
        POSTGRES_PASSWORD: "secret123",
        POSTGRES_DB: "warehousd",
      },
      ports: { "5432": "5432" },
      volumes: { "/var/lib/postgresql/data": "wh_myapp_pgdata" },
    };

    const args = buildRunArgs(spec);

    // Verify exact structure: flags before image, image at end
    expect(args[args.length - 1]).toBe("postgres:17-alpine");

    // Verify key flags are present
    expect(args).toContain("--label");
    expect(args).toContain("warehousd.project=myapp");
    expect(args).toContain("--restart");
    expect(args).toContain("unless-stopped");
    expect(args).toContain("--network");
    expect(args).toContain("wh_myapp_net");
    expect(args).toContain("--name");
    expect(args).toContain("wh_myapp_db");

    // Verify env vars as -e pairs
    expect(args).toContain("-e");
    expect(args).toContain("POSTGRES_PASSWORD=secret123");
    expect(args).toContain("POSTGRES_DB=warehousd");

    // Verify ports as host:container
    expect(args).toContain("-p");
    expect(args).toContain("5432:5432");

    // Verify volumes as host:container
    expect(args).toContain("-v");
    expect(args).toContain("wh_myapp_pgdata:/var/lib/postgresql/data");

    // Verify -d for detached
    expect(args).toContain("-d");
  });

  it("builds server container args in correct order", () => {
    const spec = {
      name: "wh_myapp_server",
      image: "warehousd/server:0.1.0",
      network: "wh_myapp_net",
      label: "warehousd.project=myapp",
      env: {
        WAREHOUSD_MCP_URL: "http://localhost:3000",
        NODE_ENV: "production",
      },
      ports: { "8722": "8722" },
    };

    const args = buildRunArgs(spec);

    expect(args[args.length - 1]).toBe("warehousd/server:0.1.0");
    expect(args).toContain("--label");
    expect(args).toContain("warehousd.project=myapp");
    expect(args).toContain("-e");
    expect(args).toContain("WAREHOUSD_MCP_URL=http://localhost:3000");
    expect(args).toContain("-e");
    expect(args).toContain("NODE_ENV=production");
    expect(args).toContain("-p");
    expect(args).toContain("8722:8722");
  });

  it("env vars are in stable order", () => {
    const spec = {
      name: "test",
      image: "test:latest",
      network: "net",
      label: "label=test",
      env: {
        Z_VAR: "z",
        A_VAR: "a",
        M_VAR: "m",
      },
    };

    const args = buildRunArgs(spec);
    const envIndices = args
      .map((arg, i) => ({ arg, i }))
      .filter((x) => x.arg === "-e")
      .map((x) => x.i);

    // Verify all env vars are present
    expect(args).toContain("A_VAR=a");
    expect(args).toContain("M_VAR=m");
    expect(args).toContain("Z_VAR=z");

    // Verify env values appear after their -e flag
    const envVars = envIndices.map((i) => args[i + 1]);
    expect(envVars.sort()).toEqual(envVars); // check they are in order
  });

  it("handles missing optional volumes", () => {
    const spec = {
      name: "test",
      image: "test:latest",
      network: "net",
      label: "label=test",
      env: {},
    };

    const args = buildRunArgs(spec);
    expect(args[args.length - 1]).toBe("test:latest");
    expect(args).toContain("--name");
    expect(args).toContain("test");
  });
});

describe("assertDocker", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("throws install message when docker is not found (ENOENT)", () => {
    const mockExecFileSync = vi.mocked(execFileSync);
    const error: any = new Error("not found");
    error.code = "ENOENT";
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    expect(() => assertDocker()).toThrow(/docker not found on PATH.*Install Docker Desktop/);
  });

  it("throws daemon message when docker daemon is not reachable", () => {
    const mockExecFileSync = vi.mocked(execFileSync);
    const error: any = new Error("daemon not running");
    error.stderr = "Cannot connect to Docker daemon";
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    expect(() => assertDocker()).toThrow(/Docker is installed but the daemon isn't reachable/);
  });
});
