import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

const spawned: { cmd: string; args: string[]; opts: unknown }[] = [];

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  // `logs` reads both of the container's streams, so it is spawnSync rather than execFileSync —
  // see the note on it in docker.ts.
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
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
  // Section headings, not questions — the wizard names its two halves so the local and the
  // production database do not read as one question asked twice.
  note: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
}));

import { execFileSync, spawnSync } from "node:child_process";
import * as clack from "@clack/prompts";
import { runLogs } from "../src/commands/logs";
import { runOpen } from "../src/commands/open";
import { confirm, promptInit, type InitAnswers } from "../src/ui/prompt";
import { DEPLOY_TARGET_IDS, DB_PROVIDER_IDS } from "@warehousd/broker";
import { dbHosts, localHosts } from "../src/db/hosts";

const INIT_DEFAULTS: InitAnswers = {
  project: "my-app",
  port: 8722,
  managed: true,
  target: "fly",
  deployManaged: true,
  dbProvider: null,
  guided: true,
  localDbProvider: null,
  dbRegion: null,
  dbOrg: null,
};

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
    vi.mocked(execFileSync).mockImplementation((_c, args) =>
      (args as string[])[0] === "inspect" ? "running" : "",
    );
    vi.mocked(spawnSync).mockReturnValue({
      stdout: "line one\nline two",
      stderr: "",
      status: 0,
    } as never);
    await expect(runLogs(dir, { tail: 50 })).resolves.toBe("line one\nline two");
  });

  // The container's stderr is where a crashed server writes, and it used to be dropped.
  it("includes the container's stderr, not just its stdout", async () => {
    vi.mocked(execFileSync).mockImplementation((_c, args) =>
      (args as string[])[0] === "inspect" ? "running" : "",
    );
    vi.mocked(spawnSync).mockReturnValue({
      stdout: "listening on 8722",
      stderr: "Error: Timeout waiting for Postgres",
      status: 0,
    } as never);
    await expect(runLogs(dir)).resolves.toContain("Timeout waiting for Postgres");
  });

  it("passes --tail through", async () => {
    vi.mocked(execFileSync).mockImplementation((_c, args) =>
      (args as string[])[0] === "inspect" ? "running" : "",
    );
    vi.mocked(spawnSync).mockReturnValue({ stdout: "", stderr: "", status: 0 } as never);
    await runLogs(dir, { tail: 25 });
    const call = vi.mocked(spawnSync).mock.calls.find((c) => (c[1] as string[])[0] === "logs");
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
    // resolveUrl checks the server container before handing back a URL.
    vi.mocked(execFileSync).mockReturnValue("running");
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

// The wizard names its two halves out loud on stdout. Swallowed here so the suite's output stays
// readable; what those headings say is asserted in ui-render.test.ts, not by reading a test log.
const SILENT = { say: () => {} };

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

  // Every select answers "managed" by default, which is not one of the mode question's values —
  // so `idIn`-style fallbacks aside, a test that cares about the later questions has to answer the
  // leading one. The order is: mode, local database, target, deploy database, and (only when
  // attaching a url) who hosts it.
  const guided = () => vi.mocked(clack.select).mockResolvedValueOnce("guided");

  it("collects the init answers", async () => {
    guided();
    const answers = await promptInit(INIT_DEFAULTS, SILENT);
    expect(answers).toEqual({
      project: "answer",
      port: 8722,
      managed: true,
      target: "fly",
      deployManaged: true,
      dbProvider: null,
      guided: true,
      localDbProvider: null,
      dbRegion: null,
      dbOrg: null,
    });
  });

  it("returns null when the wizard is cancelled", async () => {
    vi.mocked(clack.isCancel).mockReturnValueOnce(true);
    await expect(promptInit(INIT_DEFAULTS, SILENT)).resolves.toBeNull();
  });

  it("reads 'external' from the local database question", async () => {
    guided();
    vi.mocked(clack.select).mockResolvedValueOnce("external");
    const answers = await promptInit(INIT_DEFAULTS, SILENT);
    expect(answers?.managed).toBe(false);
  });

  // The provider question is only reached because the *deploy* answer was "external" — the local
  // one no longer decides it.
  it("collects the deploy target and the provider behind an external database", async () => {
    guided();
    vi.mocked(clack.select)
      .mockResolvedValueOnce("managed")
      .mockResolvedValueOnce("railway")
      .mockResolvedValueOnce("external")
      .mockResolvedValueOnce("supabase");
    const answers = await promptInit(INIT_DEFAULTS, SILENT);
    expect(answers).toMatchObject({
      managed: true,
      target: "railway",
      deployManaged: false,
      dbProvider: "supabase",
    });
  });

  // The pair that one shared flag could not express: Docker on this machine, somebody else's
  // Postgres in production.
  it("keeps the local answer out of the deploy one", async () => {
    guided();
    vi.mocked(clack.select)
      .mockResolvedValueOnce("external")
      .mockResolvedValueOnce("fly")
      .mockResolvedValueOnce("managed");
    const answers = await promptInit(INIT_DEFAULTS, SILENT);
    expect(answers).toMatchObject({ managed: false, deployManaged: true, dbProvider: null });
  });

  it("never asks who hosts a database the target will provision", async () => {
    guided();
    vi.mocked(clack.select)
      .mockResolvedValueOnce("managed")
      .mockResolvedValueOnce("compose")
      .mockResolvedValueOnce("managed");
    const answers = await promptInit(INIT_DEFAULTS, SILENT);
    expect(answers).toMatchObject({ managed: true, target: "compose", dbProvider: null });
    // mode, local database, target, deploy database — and no fifth.
    expect(clack.select).toHaveBeenCalledTimes(4);
  });

  it("offers every registered target, host and provider, not a hand-written list", async () => {
    guided();
    vi.mocked(clack.select)
      .mockResolvedValueOnce("managed")
      .mockResolvedValueOnce("fly")
      .mockResolvedValueOnce("external");
    await promptInit(INIT_DEFAULTS, SILENT);
    const values = (i: number) =>
      (vi.mocked(clack.select).mock.calls[i]?.[0] as { options: { value: string }[] }).options.map(
        (o) => o.value,
      );
    // Local: warehousd's own container, then one entry per host that has a local stack, then a url.
    expect(values(1)).toEqual(["managed", ...localHosts().map((h) => h.id), "external"]);
    // Every registered target, and then the answer none of them is: "not yet".
    expect(values(2)).toEqual([...DEPLOY_TARGET_IDS, "none"]);
    // Production: the target, then one entry per host that can create a database, then a url.
    expect(values(3)).toEqual(["managed", ...Object.keys(dbHosts), "external"]);
    expect(values(4)).toEqual([...DB_PROVIDER_IDS]);
  });

  // The escape hatch, and the reason it is the first question: manual must not offer to create
  // anything, so neither list of provider options appears.
  it("offers nothing to create when the answer is manual", async () => {
    vi.mocked(clack.select)
      .mockResolvedValueOnce("manual")
      .mockResolvedValueOnce("managed")
      .mockResolvedValueOnce("fly")
      .mockResolvedValueOnce("external");
    const answers = await promptInit(INIT_DEFAULTS, SILENT);
    expect(answers?.guided).toBe(false);
    const values = (i: number) =>
      (vi.mocked(clack.select).mock.calls[i]?.[0] as { options: { value: string }[] }).options.map(
        (o) => o.value,
      );
    expect(values(1)).toEqual(["managed", "external"]);
    expect(values(3)).toEqual(["managed", "external"]);
  });

  /**
   * "Not yet" ends the wizard early, and that is the point of it.
   *
   * Before it existed `init` always scaffolded a `deploy:` block, so somebody trying warehousd for
   * the first time got an app name, a region and a database shape they had not chosen and now had
   * to review. Answering `none` must skip the production database, its region and its
   * organisation, and leave the commented block in the template alone.
   */
  it("asks nothing about production when the answer is 'not yet'", async () => {
    guided();
    vi.mocked(clack.select).mockResolvedValueOnce("managed").mockResolvedValueOnce("none");
    const answers = await promptInit(INIT_DEFAULTS, SILENT);
    expect(answers).toMatchObject({ target: null, deployManaged: true, dbProvider: null });
    // mode, local database, target — and nothing after it.
    expect(clack.select).toHaveBeenCalledTimes(3);
  });

  it("falls back to the default target when the select hands back something unregistered", async () => {
    guided();
    vi.mocked(clack.select).mockResolvedValueOnce("managed").mockResolvedValueOnce("nowhere");
    const answers = await promptInit({ ...INIT_DEFAULTS, target: "compose" }, SILENT);
    expect(answers?.target).toBe("compose");
  });
});
