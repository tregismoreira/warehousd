import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolveProject } from "../src/project";
import { readState, ensureState, writeOutputs, readOutputs, stateDir } from "../src/state";

describe("project resolution", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wh-proj-"));
    const config = `
project: My App
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`;
    writeFileSync(join(projectDir, "warehousd.yml"), config);
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("sanitises project name from My App to my_app", () => {
    const proj = resolveProject(projectDir);
    expect(proj.name).toBe("my_app");
  });

  it("generates correct namespace names", () => {
    const proj = resolveProject(projectDir);
    expect(proj.ns.net).toBe("wh_my_app_net");
    expect(proj.ns.db).toBe("wh_my_app_db");
    expect(proj.ns.server).toBe("wh_my_app_server");
    expect(proj.ns.volume).toBe("wh_my_app_pgdata");
    expect(proj.ns.label).toBe("warehousd.project=my_app");
  });

  it("defaults db port to server.port + 1", () => {
    const proj = resolveProject(projectDir);
    expect(proj.ports.server).toBe(8722);
    expect(proj.ports.db).toBe(8723);
  });

  it("honours explicit database.port", () => {
    const customDir = mkdtempSync(join(tmpdir(), "wh-proj-custom-"));
    const config = `
project: Custom
server:
  port: 9000
database:
  port: 5433
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`;
    writeFileSync(join(customDir, "warehousd.yml"), config);
    const proj = resolveProject(customDir);
    expect(proj.ports.db).toBe(5433);
    rmSync(customDir, { recursive: true, force: true });
  });

  it("managed is true when database.url is unset", () => {
    const proj = resolveProject(projectDir);
    expect(proj.managed).toBe(true);
  });

  it("managed is false when database.url is set", () => {
    const customDir = mkdtempSync(join(tmpdir(), "wh-proj-managed-"));
    const config = `
project: External
server:
  port: 8722
database:
  url: postgresql://user:pass@host/db
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`;
    writeFileSync(join(customDir, "warehousd.yml"), config);
    const proj = resolveProject(customDir);
    expect(proj.managed).toBe(false);
    rmSync(customDir, { recursive: true, force: true });
  });

  it("sets absolute project dir", () => {
    const proj = resolveProject(projectDir);
    expect(proj.dir).toBe(projectDir);
    expect(proj.dir).toMatch(/^\//);
  });

  it("includes loaded config", () => {
    const proj = resolveProject(projectDir);
    expect(proj.cfg.project).toBe("My App");
    expect(proj.cfg.server.port).toBe(8722);
  });
});

describe("state management", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wh-state-"));
    const config = `
project: StateTest
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`;
    writeFileSync(join(projectDir, "warehousd.yml"), config);
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("readState returns null for fresh directory", () => {
    const state = readState(projectDir);
    expect(state).toBeNull();
  });

  it("ensureState generates secrets on first call", () => {
    const state = ensureState(projectDir);
    expect(state.dbPassword).toBeDefined();
    expect(state.dataRolePassword).toBeDefined();
    expect(state.betterAuthSecret).toBeDefined();
    expect(state.adminPassword).toBeDefined();
  });

  it("betterAuthSecret is at least 32 characters", () => {
    const state = ensureState(projectDir);
    expect(state.betterAuthSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("ensureState persists state to file", () => {
    const _state = ensureState(projectDir);
    const statePath = join(stateDir(projectDir), "state.json");
    expect(existsSync(statePath)).toBe(true);
  });

  it("ensureState is stable across two calls", () => {
    const state1 = ensureState(projectDir);
    const state2 = ensureState(projectDir);
    expect(state1.dbPassword).toBe(state2.dbPassword);
    expect(state1.dataRolePassword).toBe(state2.dataRolePassword);
    expect(state1.betterAuthSecret).toBe(state2.betterAuthSecret);
    expect(state1.adminPassword).toBe(state2.adminPassword);
  });

  it("readState returns persisted state", () => {
    const state = readState(projectDir);
    expect(state).not.toBeNull();
    expect(state!.dbPassword).toBeDefined();
  });
});

describe("outputs management", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wh-outputs-"));
    const config = `
project: OutputTest
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`;
    writeFileSync(join(projectDir, "warehousd.yml"), config);
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("readOutputs returns null for fresh directory", () => {
    const outputs = readOutputs(projectDir);
    expect(outputs).toBeNull();
  });

  it("writeOutputs and readOutputs round-trip", () => {
    const outputs = {
      mcpUrl: "http://localhost:8722/mcp",
      apiUrl: "http://localhost:8722",
      adminUrl: "http://localhost:8722/admin",
      databaseUrl: "postgresql://localhost:5432/db",
      env: "dev" as const,
      devClient: {
        clientId: "client-123",
        clientSecret: "secret-456",
      },
    };
    writeOutputs(projectDir, outputs);
    const read = readOutputs(projectDir);
    expect(read).toEqual(outputs);
  });
});

describe("stateDir", () => {
  it("returns <dir>/.warehousd", () => {
    const dir = "/home/user/my-project";
    expect(stateDir(dir)).toBe("/home/user/my-project/.warehousd");
  });
});
