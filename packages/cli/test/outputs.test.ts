import { describe, it, expect } from "vitest";
import { buildOutputs } from "../src/outputs";
import type { Project } from "../src/project";

describe("buildOutputs", () => {
  const mockProject: Project = {
    dir: "/tmp/test",
    cfg: {
      project: "test-project",
      server: { port: 8722 },
      collections: {},
    } as any,
    name: "test_project",
    ns: {
      net: "wh_test_project_net",
      db: "wh_test_project_db",
      server: "wh_test_project_server",
      volume: "wh_test_project_pgdata",
      label: "warehousd.project=test_project",
    },
    ports: { server: 8722, db: 8723 },
    managed: true,
  };

  const devClient = { clientId: "test-id", clientSecret: "test-secret" };
  const dbUrl = "postgres://user:pass@localhost:5432/db";

  it("produces exactly the six §11 keys", () => {
    const o = buildOutputs(mockProject, dbUrl, devClient);
    const keys = Object.keys(o).sort();
    expect(keys).toEqual(["adminUrl", "apiUrl", "databaseUrl", "devClient", "env", "mcpUrl"]);
  });

  it("honours a non-default server port", () => {
    const customProject: Project = {
      ...mockProject,
      ports: { server: 9999, db: 10000 },
    };
    const o = buildOutputs(customProject, dbUrl, devClient);
    expect(o.mcpUrl).toBe("http://localhost:9999/mcp");
    expect(o.apiUrl).toBe("http://localhost:9999");
    expect(o.adminUrl).toBe("http://localhost:9999/admin");
  });

  it("env is the literal 'dev'", () => {
    const o = buildOutputs(mockProject, dbUrl, devClient);
    expect(o.env).toBe("dev");
  });

  it("includes devClient as-is", () => {
    const o = buildOutputs(mockProject, dbUrl, devClient);
    expect(o.devClient).toEqual(devClient);
  });

  it("includes databaseUrl as-is", () => {
    const o = buildOutputs(mockProject, dbUrl, devClient);
    expect(o.databaseUrl).toBe(dbUrl);
  });
});
