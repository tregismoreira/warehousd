import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { assertFly, run, tryRun, appExists, FlyError } from "../src/fly";

vi.mock("node:child_process");

const mocked = vi.mocked(execFileSync);

// The subcommand is args[0]; every helper here dispatches on it rather than on call order, so a
// test does not silently depend on how many times assertFly happens to shell out.
function onSubcommand(handlers: Record<string, () => string>) {
  mocked.mockImplementation((_file: string, args?: readonly string[] | object) => {
    const argv = Array.isArray(args) ? (args as string[]) : [];
    const handler = handlers[argv[0] ?? ""];
    if (!handler) throw new Error(`unexpected flyctl ${argv.join(" ")}`);
    return handler();
  });
}

function enoent(): Error & { code: string } {
  return Object.assign(new Error("spawn flyctl ENOENT"), { code: "ENOENT" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertFly", () => {
  it("reports how to install flyctl when the binary is missing", () => {
    mocked.mockImplementation(() => {
      throw enoent();
    });

    // A missing binary and an unauthenticated session are different problems with different
    // fixes, so they must not collapse into one message.
    expect(() => assertFly()).toThrow(FlyError);
    expect(() => assertFly()).toThrow(/brew install flyctl/);
    expect(() => assertFly()).toThrow(/fly\.io\/install\.sh/);
    expect(() => assertFly()).toThrow(/fly\.io\/docs\/flyctl\/install/);
    expect(() => assertFly()).not.toThrow(/auth login/);
  });

  it("reports how to authenticate when flyctl is installed but not logged in", () => {
    onSubcommand({
      version: () => "flyctl v0.3.0",
      auth: () => {
        throw new Error("You must be authenticated");
      },
    });

    expect(() => assertFly()).toThrow(FlyError);
    expect(() => assertFly()).toThrow(/flyctl auth login/);
    expect(() => assertFly()).not.toThrow(/brew install/);
  });

  it("passes when flyctl is installed and authenticated", () => {
    onSubcommand({ version: () => "flyctl v0.3.0", auth: () => "someone@example.com" });

    expect(() => assertFly()).not.toThrow();
  });
});

describe("run", () => {
  it("invokes flyctl with the args verbatim and trims the output", () => {
    mocked.mockReturnValue("  deployed  ");

    expect(run(["status", "--app", "acme"])).toBe("deployed");
    expect(mocked).toHaveBeenCalledWith(
      "flyctl",
      ["status", "--app", "acme"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("passes secret material on stdin, never in argv", () => {
    mocked.mockReturnValue("ok");

    run(["secrets", "import", "--app", "acme"], { input: "TOKEN=SUPERSECRET_CANARY\n" });

    const call = mocked.mock.calls[0];
    expect(call).toBeDefined();
    const argv = call![1] as string[];
    const opts = call![2] as { input?: string };
    // argv is world-readable in the process table; stdin is not.
    expect(JSON.stringify(argv)).not.toContain("SUPERSECRET_CANARY");
    expect(opts.input).toContain("SUPERSECRET_CANARY");
  });

  // Passing `input` is not enough on its own. `execFileSync` silently discards it when stdio[0] is
  // "ignore" — no error, no warning, an exit code of 0 — which would stage a Fly app with none of
  // its secrets set and report success. The assertion above cannot see that, because it inspects
  // the options object rather than what the child actually received.
  it("configures stdin so the input is not silently discarded", () => {
    mocked.mockReturnValue("ok");

    run(["secrets", "import", "--app", "acme"], { input: "TOKEN=SUPERSECRET_CANARY\n" });

    const stdio = (mocked.mock.calls[0]![2] as { stdio?: unknown[] }).stdio;
    expect(stdio).toBeDefined();
    expect(stdio![0]).not.toBe("ignore");
  });

  it("captures stderr rather than echoing flyctl's probe failures at the user", () => {
    mocked.mockReturnValue("ok");

    run(["status", "--app", "acme"]);

    const stdio = (mocked.mock.calls[0]![2] as { stdio?: unknown[] }).stdio;
    expect(stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("lets a real deploy stream its build log", () => {
    mocked.mockReturnValue("ok");

    run(["deploy", "--app", "acme"]);

    const stdio = (mocked.mock.calls[0]![2] as { stdio?: unknown[] }).stdio;
    expect(stdio![2]).toBe("inherit");
  });

  it("redacts a failing secrets command so no credential reaches the error", () => {
    mocked.mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), {
        stderr: "could not set TOKEN=SUPERSECRET_CANARY",
      });
    });

    let message = "";
    try {
      run(["secrets", "import", "--app", "acme"], { input: "TOKEN=SUPERSECRET_CANARY\n" });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).not.toBe("");
    expect(message).not.toContain("SUPERSECRET_CANARY");
  });

  it("surfaces stderr for a non-secrets command, where there is nothing to leak", () => {
    mocked.mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), { stderr: "Error: no such region 'zzz'" });
    });

    expect(() => run(["deploy"])).toThrow(/no such region/);
  });
});

describe("tryRun", () => {
  it("reports success with the output", () => {
    mocked.mockReturnValue("running");
    expect(tryRun(["status"])).toEqual({ ok: true, out: "running" });
  });

  it("swallows failure instead of throwing", () => {
    mocked.mockImplementation(() => {
      throw new Error("exit 1");
    });
    expect(tryRun(["status"])).toEqual({ ok: false, out: "" });
  });
});

describe("appExists", () => {
  it("is true when the app resolves", () => {
    mocked.mockReturnValue("Deployed");
    expect(appExists("acme")).toBe(true);
    expect(mocked).toHaveBeenCalledWith(
      "flyctl",
      ["status", "--app", "acme"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("is false when the app does not exist", () => {
    mocked.mockImplementation(() => {
      throw new Error("Could not find App");
    });
    expect(appExists("nope")).toBe(false);
  });
});
