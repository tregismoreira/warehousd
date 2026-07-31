import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
}));

import { execFileSync } from "node:child_process";
import { resolveLogTarget } from "../src/commands/logs";
import { resolveUrl, openerFor } from "../src/commands/open";
import { collectSecrets, secretsJson } from "../src/commands/secrets";
import { isInteractive, NonInteractiveError, confirm } from "../src/ui/prompt";

let dir: string;

const CONFIG = `project: harbor
server:
  port: 8722
collections:
  a:
    description: d
    fields:
      id: { type: uuid, posture: allow, pk: true }
`;

const OUTPUTS = {
  mcpUrl: "http://localhost:8722/mcp",
  apiUrl: "http://localhost:8722",
  adminUrl: "http://localhost:8722/admin",
  databaseUrl: "postgres://warehousd:pw@localhost:8723/warehousd",
  env: "dev",
  devClient: { clientId: "cid", clientSecret: "csecret0123456789" },
};

const STATE = {
  dbPassword: "dbpassword0123456",
  dataRolePassword: "drp",
  betterAuthSecret: "bas",
  adminPassword: "adminpassword0123",
  devClientSecret: "csecret0123456789",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-cmd-"));
  writeFileSync(join(dir, "warehousd.yml"), CONFIG);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeStateFiles() {
  mkdirSync(join(dir, ".warehousd"), { recursive: true });
  writeFileSync(join(dir, ".warehousd", "outputs.json"), JSON.stringify(OUTPUTS));
  writeFileSync(join(dir, ".warehousd", "state.json"), JSON.stringify(STATE));
}

describe("logs", () => {
  it("resolves the server container from the project name", () => {
    expect(resolveLogTarget(dir, "server")).toBe("wh_harbor_server");
  });

  it("resolves the database container", () => {
    expect(resolveLogTarget(dir, "db")).toBe("wh_harbor_db");
  });

  it("refuses --service db when the project brings its own Postgres", () => {
    writeFileSync(
      join(dir, "warehousd.yml"),
      CONFIG.replace("server:", "database:\n  url: postgres://elsewhere/db\nserver:"),
    );
    expect(() => resolveLogTarget(dir, "db")).toThrow(/no database container/);
  });
});

describe("open", () => {
  const serverRunning = () => vi.mocked(execFileSync).mockReturnValue("running");

  it("resolves each target from outputs.json", () => {
    writeStateFiles();
    serverRunning();
    expect(resolveUrl(dir, "admin")).toBe(OUTPUTS.adminUrl);
    expect(resolveUrl(dir, "mcp")).toBe(OUTPUTS.mcpUrl);
    expect(resolveUrl(dir, "api")).toBe(OUTPUTS.apiUrl);
  });

  it("says what to run when the stack has never been started", () => {
    expect(() => resolveUrl(dir, "admin")).toThrow(/warehousd start/);
  });

  // `stop` keeps outputs.json — only `--destroy` removes it — so the file being there is not
  // evidence that anything is listening. Without this, `open` launched a browser at a dead port.
  it("refuses to open a stopped stack rather than launching a dead URL", () => {
    writeStateFiles();
    vi.mocked(execFileSync).mockReturnValue("exited");
    expect(() => resolveUrl(dir, "admin")).toThrow(/warehousd start/);
  });

  it("refuses when the container is gone entirely", () => {
    writeStateFiles();
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("No such object");
    });
    expect(() => resolveUrl(dir, "admin")).toThrow(/not there/);
  });

  it("picks the platform opener", () => {
    expect(openerFor("darwin")?.cmd).toBe("open");
    expect(openerFor("linux")?.cmd).toBe("xdg-open");
    expect(openerFor("win32")?.cmd).toBe("cmd");
    expect(openerFor("freebsd")).toBeNull();
  });
});

describe("secrets", () => {
  it("collects both files, flagging which entries are secret", () => {
    writeStateFiles();
    const entries = collectSecrets(dir);
    const byLabel = Object.fromEntries(entries.map((e) => [e.label, e]));
    expect(byLabel["Admin password"]!.secret).toBe(true);
    expect(byLabel["Admin password"]!.value).toBe(STATE.adminPassword);
    expect(byLabel["Dev client ID"]!.secret).toBe(false);
  });

  it("--json carries full values, because a caller asked for them explicitly", () => {
    writeStateFiles();
    const json = secretsJson(dir);
    expect(json["Admin password"]).toBe(STATE.adminPassword);
    expect(json["Dev client secret"]).toBe(STATE.devClientSecret);
  });

  it("explains itself when there is nothing yet", () => {
    expect(() => collectSecrets(dir)).toThrow(/warehousd start/);
  });
});

describe("prompt gating", () => {
  it("is interactive only when both streams are terminals", () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(isInteractive({}, {})).toBe(false);
  });

  // Without this the e2e suite, which pipes stdio, would hang on a prompt rather than fail.
  it("refuses rather than hangs when there is nobody to ask, and names the flag", async () => {
    await expect(
      confirm({ message: "Remove everything?", flag: "--yes", interactive: false }),
    ).rejects.toThrow(NonInteractiveError);
    await expect(
      confirm({ message: "Remove everything?", flag: "--yes", interactive: false }),
    ).rejects.toThrow(/--yes/);
  });
});
