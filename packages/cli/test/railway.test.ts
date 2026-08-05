import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { assertRailway, run, tryRun, linkedProject, RailwayError } from "../src/railway";
import { setVerbose } from "../src/verbose";

vi.mock("node:child_process");

const mocked = vi.mocked(execFileSync);

// The subcommand is args[0]; every helper dispatches on it rather than on call order, so a test
// does not silently depend on how many times assertRailway happens to shell out.
function onSubcommand(handlers: Record<string, () => string>) {
  mocked.mockImplementation((_file: string, args?: readonly string[] | object) => {
    const argv = Array.isArray(args) ? (args as string[]) : [];
    const handler = handlers[argv[0] ?? ""];
    if (!handler) throw new Error(`unexpected railway ${argv.join(" ")}`);
    return handler();
  });
}

function enoent(): Error & { code: string } {
  return Object.assign(new Error("spawn railway ENOENT"), { code: "ENOENT" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setVerbose(false);
  vi.restoreAllMocks();
});

describe("assertRailway", () => {
  it("reports how to install the CLI when the binary is missing", () => {
    mocked.mockImplementation(() => {
      throw enoent();
    });

    // A missing binary and an unauthenticated session are different problems with different
    // fixes, so they must not collapse into one message.
    expect(() => assertRailway()).toThrow(RailwayError);
    expect(() => assertRailway()).toThrow(/@railway\/cli/);
    expect(() => assertRailway()).not.toThrow(/railway login/);
  });

  it("reports both ways to authenticate when the CLI is installed but logged out", () => {
    onSubcommand({
      "--version": () => "railway 4.0.0",
      whoami: () => {
        throw new Error("Unauthorized");
      },
    });

    // RAILWAY_TOKEN is the only one of the two that works in CI, so a message naming only
    // `railway login` would send an automated deploy down a path it cannot take.
    expect(() => assertRailway()).toThrow(/railway login/);
    expect(() => assertRailway()).toThrow(/RAILWAY_TOKEN/);
    expect(() => assertRailway()).not.toThrow(/npm i -g/);
  });

  it("passes when the CLI is installed and authenticated", () => {
    onSubcommand({ "--version": () => "railway 4.0.0", whoami: () => "someone@example.com" });

    expect(() => assertRailway()).not.toThrow();
  });
});

describe("run", () => {
  it("invokes railway with the args verbatim, in the project directory", () => {
    mocked.mockReturnValue("  linked  ");

    expect(run(["status"], { cwd: "/tmp/proj" })).toBe("linked");
    expect(mocked).toHaveBeenCalledWith(
      "railway",
      ["status"],
      expect.objectContaining({ encoding: "utf8", cwd: "/tmp/proj" }),
    );
  });

  it("captures stderr rather than echoing its own probe failures at the user", () => {
    mocked.mockReturnValue("ok");

    run(["status", "--json"], { cwd: "/tmp/proj" });

    expect((mocked.mock.calls[0]![2] as { stdio?: unknown[] }).stdio).toEqual([
      "pipe",
      "pipe",
      "pipe",
    ]);
  });

  it("lets a real deploy stream its build log", () => {
    mocked.mockReturnValue("");

    run(["up", "--detach"], { cwd: "/tmp/proj" });

    const stdio = (mocked.mock.calls[0]![2] as { stdio?: unknown[] }).stdio;
    expect(stdio![1]).toBe("inherit");
    expect(stdio![2]).toBe("inherit");
  });

  it("surfaces stderr for a command with nothing to leak", () => {
    mocked.mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), { stderr: "Project not found" });
    });

    expect(() => run(["status"], { cwd: "/tmp/proj" })).toThrow(/Project not found/);
  });
});

// Railway has no `secrets import --stage`: `variables --set K=V` puts the value in argv, and the
// process table is a place warehousd cannot clean. What it can do is keep the credential out of
// everything it writes itself — the trace and the thrown error.
describe("variables --set, the one invocation that carries secret material", () => {
  it("redacts the value from a --verbose trace but keeps the name", () => {
    setVerbose(true);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    mocked.mockReturnValue("");

    run(["variables", "--service", "acme", "--set", "BETTER_AUTH_SECRET=SUPERSECRET_CANARY"], {
      cwd: "/tmp/proj",
    });

    const out = stderr.join("");
    expect(out).not.toContain("SUPERSECRET_CANARY");
    // The name is the whole value of the trace, and it is not the half that is secret.
    expect(out).toContain("BETTER_AUTH_SECRET=***");
  });

  it("redacts a failure, which echoes the assignment it could not apply", () => {
    mocked.mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), {
        stderr: "could not set BETTER_AUTH_SECRET=SUPERSECRET_CANARY",
      });
    });

    let message = "";
    try {
      run(["variables", "--service", "acme", "--set", "BETTER_AUTH_SECRET=SUPERSECRET_CANARY"], {
        cwd: "/tmp/proj",
      });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).not.toBe("");
    expect(message).not.toContain("SUPERSECRET_CANARY");
  });

  // Reading variables back is how `provisionDatabase` finds DATABASE_URL. Collapsing its failures
  // into "failed to set variables" would report the wrong operation for the wrong reason.
  it("keeps the real error for a read, which sets nothing", () => {
    mocked.mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), { stderr: "Service not found" });
    });

    expect(() => run(["variables", "--service", "acme", "--json"], { cwd: "/tmp/proj" })).toThrow(
      /Service not found/,
    );
  });
});

describe("tryRun", () => {
  it("reports success with the output", () => {
    mocked.mockReturnValue("up");
    expect(tryRun(["status"], { cwd: "/tmp/proj" })).toEqual({ ok: true, out: "up" });
  });

  it("swallows failure instead of throwing", () => {
    mocked.mockImplementation(() => {
      throw new Error("exit 1");
    });
    expect(tryRun(["status"], { cwd: "/tmp/proj" })).toEqual({ ok: false, out: "" });
  });
});

describe("linkedProject", () => {
  it("reads the project name and its service names", () => {
    mocked.mockReturnValue(
      JSON.stringify({
        name: "harbor-warehousd",
        services: {
          edges: [{ node: { name: "harbor-warehousd" } }, { node: { name: "Postgres" } }],
        },
      }),
    );

    expect(linkedProject("/tmp/proj")).toEqual({
      name: "harbor-warehousd",
      services: ["harbor-warehousd", "Postgres"],
    });
  });

  it("is null when this directory is linked to nothing", () => {
    mocked.mockImplementation(() => {
      throw new Error("No linked project found");
    });

    expect(linkedProject("/tmp/proj")).toBeNull();
  });

  // The shape of `status --json` has moved across CLI versions. An answer this cannot read is
  // reported as "nothing linked", which the caller responds to by creating one — idempotent
  // either way, and better than a crash mid-deploy.
  it("is null when the answer is not JSON", () => {
    mocked.mockReturnValue("Project: harbor-warehousd");

    expect(linkedProject("/tmp/proj")).toBeNull();
  });

  it("reports no services when the shape is unrecognised", () => {
    mocked.mockReturnValue(JSON.stringify({ name: "harbor-warehousd", services: {} }));

    expect(linkedProject("/tmp/proj")).toEqual({ name: "harbor-warehousd", services: [] });
  });
});
