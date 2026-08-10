import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { ensureToolsFor, requiredTools } from "../src/init-tools";
import { silentReporter, type Reporter } from "../src/ui/reporter";
import type { InitAnswers } from "../src/ui/prompt";

vi.mock("node:child_process");

const mocked = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

const ANSWERS: InitAnswers = {
  project: "harbor",
  port: 8722,
  managed: true,
  target: "fly",
  deployManaged: true,
  dbProvider: null,
  guided: true,
  runtime: "docker",
  localDbProvider: null,
  dbRegion: null,
  dbOrg: null,
};

/** A reporter that records what the operator would have seen. */
function recording(): { reporter: Reporter; warnings: string[] } {
  const warnings: string[] = [];
  return {
    reporter: { ...silentReporter, warn: (m) => warnings.push(m) },
    warnings,
  };
}

describe("requiredTools", () => {
  it("always needs the container engine, whichever database is chosen", () => {
    expect(requiredTools(ANSWERS).map((t) => t.bin)).toEqual(["docker"]);
    expect(requiredTools({ ...ANSWERS, runtime: "podman" }).map((t) => t.bin)).toEqual(["podman"]);
  });

  it("adds the local stack and the production host", () => {
    const tools = requiredTools({
      ...ANSWERS,
      localDbProvider: "supabase",
      dbProvider: "neon",
      deployManaged: true,
    });
    expect(tools.map((t) => t.bin)).toEqual(["docker", "supabase", "neon"]);
  });

  // Attaching a url needs no CLI at all, which is the whole point of the manual path.
  it("needs no provider CLI when a url is being attached", () => {
    const tools = requiredTools({ ...ANSWERS, dbProvider: "supabase", deployManaged: false });
    expect(tools.map((t) => t.bin)).toEqual(["docker"]);
  });

  it("asks for the same CLI once when it is used both locally and in production", () => {
    const tools = requiredTools({
      ...ANSWERS,
      localDbProvider: "supabase",
      dbProvider: "supabase",
    });
    expect(tools.map((t) => t.bin)).toEqual(["docker", "supabase"]);
  });

  // flyctl is checked by `warehousd deploy`'s own pre-flight, where it is actually needed. `init`
  // scaffolds a deploy block that may never be used; installing for it would be a guess.
  it("does not reach for the deploy target's CLI", () => {
    expect(requiredTools({ ...ANSWERS, target: "fly" }).map((t) => t.bin)).not.toContain("flyctl");
  });
});

describe("ensureToolsFor", () => {
  /**
   * The bug this covers. `confirm` throws NonInteractiveError off a TTY, which is the right
   * refusal for `offerInstall`'s other callers — an unattended run must not mutate the machine.
   * Uncaught here it killed `warehousd init` outright, so `--no-input` with a missing provider CLI
   * wrote no warehousd.yml at all. Writing the config is the thing that was asked for; the missing
   * CLI is advisory, and `warehousd deploy` is the command that refuses over it.
   */
  it("warns rather than aborting when a CLI is missing and nobody can be asked", async () => {
    mocked.mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const { reporter, warnings } = recording();

    await expect(
      ensureToolsFor(ANSWERS, { reporter, interactive: false }),
    ).resolves.toBeUndefined();

    expect(warnings.join("\n")).toMatch(/--install-missing/);
  });

  // Installed but logged out is a different problem with a different fix, and neither is fatal to
  // writing a config file.
  it("warns without offering an install when the tool is present but not ready", async () => {
    mocked.mockImplementation((_bin, args) => {
      if ((args as string[])[0] === "--version") return "Docker version 27.0.0";
      throw new Error("Cannot connect to the Docker daemon");
    });
    const { reporter, warnings } = recording();

    await ensureToolsFor(ANSWERS, { reporter, interactive: false });

    expect(warnings.join("\n")).toMatch(/daemon isn't reachable/);
    // Nothing was installed on the way to saying so.
    const argv = mocked.mock.calls.map((c) => String(c[0]));
    expect(argv).not.toContain("brew");
    expect(argv).not.toContain("npm");
  });

  it("says nothing when every tool it needs is there", async () => {
    mocked.mockReturnValue("ok");
    const { reporter, warnings } = recording();

    await ensureToolsFor(ANSWERS, { reporter, interactive: false });

    expect(warnings).toEqual([]);
  });
});
