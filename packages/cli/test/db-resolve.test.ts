import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolveDbUrl } from "../src/index";
import { ensureState, writeOutputs } from "../src/state";

describe("resolveDbUrl", () => {
  let projectDir: string;
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wh-resolve-db-"));
    originalDatabaseUrl = process.env.DATABASE_URL;
  });

  afterEach(() => {
    // Restore DATABASE_URL
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns explicit url when provided", () => {
    delete process.env.DATABASE_URL;
    const url = resolveDbUrl(projectDir, "postgres://explicit/db");
    expect(url).toBe("postgres://explicit/db");
  });

  it("uses DATABASE_URL env var when no explicit url", () => {
    process.env.DATABASE_URL = "postgres://env/db";
    const url = resolveDbUrl(projectDir);
    expect(url).toBe("postgres://env/db");
  });

  it("uses outputs.json databaseUrl when no explicit url or env var", () => {
    delete process.env.DATABASE_URL;
    ensureState(projectDir); // create state dir
    writeOutputs(projectDir, {
      mcpUrl: "http://localhost:3000",
      apiUrl: "http://localhost:8722",
      adminUrl: "http://localhost:8722/admin",
      databaseUrl: "postgres://outputs/db",
      env: "dev",
      devClient: {
        clientId: "id",
        clientSecret: "secret",
      },
    });
    const url = resolveDbUrl(projectDir);
    expect(url).toBe("postgres://outputs/db");
  });

  it("explicit url takes precedence over DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://env/db";
    const url = resolveDbUrl(projectDir, "postgres://explicit/db");
    expect(url).toBe("postgres://explicit/db");
  });

  it("DATABASE_URL takes precedence over outputs.json", () => {
    process.env.DATABASE_URL = "postgres://env/db";
    ensureState(projectDir);
    writeOutputs(projectDir, {
      mcpUrl: "http://localhost:3000",
      apiUrl: "http://localhost:8722",
      adminUrl: "http://localhost:8722/admin",
      databaseUrl: "postgres://outputs/db",
      env: "dev",
      devClient: {
        clientId: "id",
        clientSecret: "secret",
      },
    });
    const url = resolveDbUrl(projectDir);
    expect(url).toBe("postgres://env/db");
  });

  it("throws error when all three are absent", () => {
    delete process.env.DATABASE_URL;
    expect(() => resolveDbUrl(projectDir)).toThrow(
      "No database. Pass --db, set DATABASE_URL, or run `warehousd start` first."
    );
  });
});
