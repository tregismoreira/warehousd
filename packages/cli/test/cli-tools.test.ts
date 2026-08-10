import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  checkTool,
  detectManagers,
  installCommand,
  missingToolMessage,
  offerInstall,
  type CliTool,
  type ToolProbe,
} from "../src/cli-tools";
import { NonInteractiveError } from "../src/ui/prompt";

vi.mock("node:child_process");

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * A machine, described rather than inspected.
 *
 * Every test here states which package managers exist, because the whole point of this module is
 * to answer differently on different machines — and a suite that read the ambient PATH would pass
 * on the laptop that wrote it and nowhere else.
 */
function machine(platform: NodeJS.Platform, bins: string[], pathVar = "/usr/bin"): ToolProbe {
  const separator = platform === "win32" ? ";" : ":";
  const dirs = pathVar.split(separator);
  return {
    platform,
    env: { PATH: pathVar, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    exists: (path) =>
      dirs.some((dir) =>
        bins.some((bin) => path === `${dir}/${bin}` || path === `${dir}/${bin}.EXE`),
      ),
  };
}

const tool: CliTool = {
  bin: "widget",
  label: "Widget CLI",
  versionArgs: ["--version"],
  readyArgs: ["whoami"],
  readyHint: "Not authenticated with widget. Run: widget login",
  docsUrl: "https://example.invalid/widget",
  installers: [
    { manager: "npm", args: ["i", "-g", "widget"] },
    { manager: "brew", args: ["install", "widget"] },
    { manager: "apt-get", args: ["install", "-y", "widget"] },
  ],
};

describe("detectManagers", () => {
  it("offers only what the platform has and PATH confirms", () => {
    expect(detectManagers(machine("darwin", ["brew", "npm"]))).toEqual(["brew", "npm"]);
    expect(detectManagers(machine("darwin", ["npm"]))).toEqual(["npm"]);
    // apt-get is a Linux candidate; on darwin it is never even looked for.
    expect(detectManagers(machine("darwin", ["apt-get", "npm"]))).toEqual(["npm"]);
  });

  it("knows a different set per platform", () => {
    expect(detectManagers(machine("linux", ["apt-get", "npm"]))).toEqual(["apt-get", "npm"]);
    expect(detectManagers(machine("win32", ["winget", "npm"], "C:\\bin"))).toEqual([
      "winget",
      "npm",
    ]);
  });

  it("falls back to npm on a platform none of the tables cover", () => {
    expect(detectManagers(machine("freebsd", ["npm"]))).toEqual(["npm"]);
  });

  it("finds nothing when PATH is empty, rather than assuming", () => {
    expect(detectManagers({ platform: "darwin", env: {}, exists: () => true })).toEqual([]);
  });
});

describe("installCommand", () => {
  // The tool's order, not the platform's: `installers` is where a provider's own preferred route
  // is recorded, and npm-before-brew is a real preference for at least one of them.
  it("takes the tool's first installer that this machine can run", () => {
    expect(installCommand(tool, machine("darwin", ["brew", "npm"]))?.argv).toEqual([
      "npm",
      "i",
      "-g",
      "widget",
    ]);
    expect(installCommand(tool, machine("darwin", ["brew"]))?.argv).toEqual([
      "brew",
      "install",
      "widget",
    ]);
  });

  it("is undefined when no manager we know of is present", () => {
    expect(installCommand(tool, machine("darwin", []))).toBeUndefined();
  });

  it("flags the managers that would need root", () => {
    expect(installCommand(tool, machine("linux", ["apt-get"]))?.needsRoot).toBe(true);
    expect(installCommand(tool, machine("linux", ["npm"]))?.needsRoot).toBe(false);
  });
});

describe("missingToolMessage", () => {
  it("names the one command that works here", () => {
    expect(missingToolMessage(tool, machine("darwin", ["brew"]))).toBe(
      "widget not found on PATH. Install with brew install widget, or see https://example.invalid/widget",
    );
  });

  it("lists every route when it cannot tell", () => {
    const msg = missingToolMessage(tool, machine("darwin", []));
    expect(msg).toContain("one of:");
    expect(msg).toContain("npm i -g widget");
    expect(msg).toContain("brew install widget");
  });
});

describe("checkTool", () => {
  const probe = (exec: ToolProbe["exec"]): ToolProbe => ({
    ...machine("darwin", ["brew"]),
    exec,
  });

  it("passes, carrying the version", () => {
    const check = checkTool(
      tool,
      probe(() => "widget 1.2.3\nbuild abc"),
    );
    expect(check).toEqual({
      id: "widget-ready",
      ok: true,
      detail: "widget is ready — widget 1.2.3",
    });
  });

  it("reports a missing binary as an install problem", () => {
    const check = checkTool(
      tool,
      probe(() => {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }),
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("brew install widget");
  });

  // The distinction this module exists to keep. "Installed but logged out" and "not installed" are
  // one sentence apart and the sentences are different; collapsing them turns a one-line fix into
  // a support question.
  it("reports an unauthenticated tool as an auth problem, not an install one", () => {
    const check = checkTool(
      tool,
      probe((_bin, args) => {
        if (args[0] === "whoami") throw new Error("no session");
        return "widget 1.2.3";
      }),
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toBe("Not authenticated with widget. Run: widget login");
    expect(check.detail).not.toContain("not found on PATH");
  });
});

describe("offerInstall", () => {
  const say = () => {};

  it("refuses off a TTY, naming the flag rather than installing silently", async () => {
    await expect(
      offerInstall(tool, { probe: machine("darwin", ["npm"]), interactive: false, say }),
    ).rejects.toBeInstanceOf(NonInteractiveError);

    // The rule that matters: an unattended run must not have mutated the machine on its way to
    // that refusal.
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it("runs the install once consent is given in advance", async () => {
    const outcome = await offerInstall(tool, {
      probe: machine("darwin", ["npm"]),
      assumeYes: true,
      say,
    });

    expect(outcome).toEqual({ ok: true, installed: true, command: "npm i -g widget" });
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "npm",
      ["i", "-g", "widget"],
      expect.objectContaining({ stdio: ["pipe", "inherit", "inherit"] }),
    );
  });

  it("never invokes sudo — it prints the command instead", async () => {
    const outcome = await offerInstall(tool, {
      probe: machine("linux", ["apt-get"]),
      assumeYes: true,
      say,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("sudo apt-get install -y widget");
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it("stops with every route printed when no manager is present", async () => {
    const outcome = await offerInstall(tool, {
      probe: machine("darwin", []),
      assumeYes: true,
      say,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("npm i -g widget");
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it("hands back the manager's failure as something to do, not a stack trace", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const outcome = await offerInstall(tool, {
      probe: machine("darwin", ["npm"]),
      assumeYes: true,
      say,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("Install Widget CLI by hand");
  });
});
