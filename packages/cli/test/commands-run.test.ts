import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

const spawned: { cmd: string; args: string[]; opts: unknown }[] = [];

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  spawn: vi.fn((cmd: string, args: string[], opts: unknown) => {
    spawned.push({ cmd, args, opts });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    // Resolve on the next tick so `runLogs`'s promise settles without a real process.
    setImmediate(() => child.emit("close", 0));
    return child;
  }),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  text: vi.fn(() => Promise.resolve("answer")),
  select: vi.fn(() => Promise.resolve("managed")),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import * as clack from "@clack/prompts";
import { runLogs } from "../src/commands/logs";
import { runOpen } from "../src/commands/open";
import { confirm, promptInit } from "../src/ui/prompt";

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-run-"));
  writeFileSync(join(dir, "warehousd.yml"), CONFIG);
  spawned.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("runLogs", () => {
  it("returns the log text for a one-shot read", async () => {
    vi.mocked(execFileSync).mockImplementation((_c, args) => {
      const a = args as string[];
      if (a[0] === "inspect") return "running";
      if (a[0] === "logs") return "line one\nline two";
      return "";
    });
    await expect(runLogs(dir, { tail: 50 })).resolves.toBe("line one\nline two");
  });

  it("passes --tail through", async () => {
    vi.mocked(execFileSync).mockImplementation((_c, args) => {
      const a = args as string[];
      return a[0] === "inspect" ? "running" : "";
    });
    await runLogs(dir, { tail: 25 });
    const call = vi.mocked(execFileSync).mock.calls.find((c) => (c[1] as string[])[0] === "logs");
    expect(call?.[1]).toEqual(["logs", "--tail", "25", "wh_harbor_server"]);
  });

  it("says what to run when the container does not exist", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("No such object");
    });
    await expect(runLogs(dir)).rejects.toThrow(/warehousd start/);
  });

  // --follow cannot go through execFileSync: it never returns.
  it("spawns with inherited streams when following, and returns null", async () => {
    vi.mocked(execFileSync).mockImplementation((_c, args) =>
      (args as string[])[0] === "inspect" ? "running" : "",
    );
    await expect(runLogs(dir, { follow: true, tail: 10 })).resolves.toBeNull();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(["logs", "--follow", "--tail", "10", "wh_harbor_server"]);
    expect((spawned[0]!.opts as { stdio: unknown }).stdio).toEqual([
      "ignore",
      "inherit",
      "inherit",
    ]);
  });
});

describe("runOpen", () => {
  beforeEach(() => {
    mkdirSync(join(dir, ".warehousd"), { recursive: true });
    writeFileSync(
      join(dir, ".warehousd", "outputs.json"),
      JSON.stringify({
        mcpUrl: "http://localhost:8722/mcp",
        apiUrl: "http://localhost:8722",
        adminUrl: "http://localhost:8722/admin",
        databaseUrl: "postgres://warehousd:pw@localhost:8723/warehousd",
        env: "dev",
        devClient: { clientId: "c", clientSecret: "s" },
      }),
    );
  });

  it("launches the platform opener, detached so the browser outlives us", () => {
    const r = runOpen(dir, "admin", "darwin");
    expect(r.opened).toBe(true);
    expect(spawned[0]!.cmd).toBe("open");
    expect(spawned[0]!.args).toEqual(["http://localhost:8722/admin"]);
    expect((spawned[0]!.opts as { detached: boolean }).detached).toBe(true);
  });

  it("prints rather than spawns where no opener is known", () => {
    const r = runOpen(dir, "mcp", "freebsd");
    expect(r.opened).toBe(false);
    expect(r.url).toBe("http://localhost:8722/mcp");
    expect(spawned).toHaveLength(0);
  });
});

describe("prompt wrappers", () => {
  it("asks clack when interactive and returns its answer", async () => {
    await expect(
      confirm({ message: "Remove it?", flag: "--yes", interactive: true }),
    ).resolves.toBe(true);
    expect(clack.confirm).toHaveBeenCalled();
  });

  it("treats a cancelled confirm as a no", async () => {
    vi.mocked(clack.isCancel).mockReturnValueOnce(true);
    await expect(
      confirm({ message: "Remove it?", flag: "--yes", interactive: true }),
    ).resolves.toBe(false);
  });

  it("collects the init answers", async () => {
    const answers = await promptInit({ project: "my-app", port: 8722, managed: true });
    expect(answers).toEqual({ project: "answer", port: 8722, managed: true });
  });

  it("returns null when the wizard is cancelled", async () => {
    vi.mocked(clack.isCancel).mockReturnValueOnce(true);
    await expect(promptInit({ project: "my-app", port: 8722, managed: true })).resolves.toBeNull();
  });

  it("reads 'external' from the database question", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce("external");
    const answers = await promptInit({ project: "my-app", port: 8722, managed: true });
    expect(answers?.managed).toBe(false);
  });
});
