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

/**
 * A machine to answer questions about, so these tests do not ask the one they are running on.
 *
 * Docker installs through `brew` or `winget` and through nothing else, so "is there a package
 * manager that could install it?" is answered differently on macOS than on Linux — and the answer
 * decides which of two warnings comes out. Pinning it here is what stopped this file passing on a
 * developer's Mac and failing on every Linux CI runner.
 */
function machine(platform: NodeJS.Platform, managers: string[] = []) {
  return {
    platform,
    env: { PATH: "/usr/bin" },
    exists: (path: string) => managers.some((m) => path.endsWith(`/${m}`)),
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
      ensureToolsFor(ANSWERS, {
        reporter,
        interactive: false,
        probe: machine("darwin", ["brew"]),
      }),
    ).resolves.toBeUndefined();

    expect(warnings.join("\n")).toMatch(/--install-missing/);
  });

  // The other half of the same branch, and the one CI actually runs on: Docker has no `apt-get`
  // installer, so there is no command to offer and the warning has to carry the manual route
  // instead. Still a warning — `init` writes the config either way.
  it("falls back to manual instructions where no package manager can install the tool", async () => {
    mocked.mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const { reporter, warnings } = recording();

    await expect(
      ensureToolsFor(ANSWERS, {
        reporter,
        interactive: false,
        probe: machine("linux", ["apt-get"]),
      }),
    ).resolves.toBeUndefined();

    const said = warnings.join("\n");
    expect(said).toMatch(/No package manager warehousd recognises/);
    expect(said).toContain("https://docs.docker.com/get-docker/");
    expect(said).not.toMatch(/--install-missing/);
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
