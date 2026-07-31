import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("node:child_process");

import { execFileSync } from "node:child_process";
import { setVerbose, isVerbose } from "../src/verbose";
import { run as dockerRun } from "../src/docker";
import { run as flyRun, FlyError } from "../src/fly";

let stderr: string[];

beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  setVerbose(false);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("the --verbose switch", () => {
  it("is off by default", () => {
    expect(isVerbose()).toBe(false);
  });

  it("says nothing when off", () => {
    vi.mocked(execFileSync).mockReturnValue("");
    dockerRun(["ps"]);
    expect(stderr.join("")).toBe("");
  });

  it("echoes docker commands when on", () => {
    setVerbose(true);
    vi.mocked(execFileSync).mockReturnValue("");
    dockerRun(["network", "inspect", "wh_harbor_net"]);
    expect(stderr.join("")).toContain("$ docker network inspect wh_harbor_net");
  });

  // It used to live inside docker.ts, so `warehousd deploy --verbose` set a flag nothing in the
  // deploy path read — and a deploy is almost entirely flyctl.
  it("echoes flyctl commands too", () => {
    setVerbose(true);
    vi.mocked(execFileSync).mockReturnValue("");
    flyRun(["status", "--app", "acme"]);
    expect(stderr.join("")).toContain("$ flyctl status --app acme");
  });

  it("echoes a failure's stderr when on", () => {
    setVerbose(true);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), { stderr: "daemon said no" });
    });
    expect(() => dockerRun(["ps"])).toThrow();
    expect(stderr.join("")).toContain("daemon said no");
  });
});

// The one place --verbose must stay quiet. flyctl echoes the offending assignment when a secret
// fails to set, so that stderr can carry the credential; it is redacted out of the thrown error,
// and a debug flag must not be a way around that.
describe("--verbose never becomes a way to print secrets", () => {
  it("keeps a failing `fly secrets` redacted", () => {
    setVerbose(true);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), {
        stderr: "could not set TOKEN=SUPERSECRET_CANARY",
      });
    });

    let message = "";
    try {
      flyRun(["secrets", "import", "--app", "acme"], { input: "TOKEN=SUPERSECRET_CANARY\n" });
    } catch (err) {
      message = (err as FlyError).message;
    }

    expect(message).not.toContain("SUPERSECRET_CANARY");
    expect(stderr.join("")).not.toContain("SUPERSECRET_CANARY");
  });

  // argv is safe, and worth echoing: the secret travels on stdin precisely so it is not here.
  it("still echoes the secrets argv, which carries no credential", () => {
    setVerbose(true);
    vi.mocked(execFileSync).mockReturnValue("");
    flyRun(["secrets", "import", "--app", "acme", "--stage"], { input: "TOKEN=CANARY\n" });
    const out = stderr.join("");
    expect(out).toContain("$ flyctl secrets import --app acme --stage");
    expect(out).not.toContain("CANARY");
  });
});
