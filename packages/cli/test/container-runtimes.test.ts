import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { CONTAINER_RUNTIME_IDS, DEFAULT_CONTAINER_RUNTIME_ID } from "@warehousd/broker";
import { runtimes, runtimeFor } from "../src/containers/runtimes";
import {
  containerRuntime,
  setContainerRuntime,
  run,
  runtimeVersion,
  assertRuntime,
  DockerError,
} from "../src/docker";

vi.mock("node:child_process");

afterEach(() => {
  vi.clearAllMocks();
  // The active runtime is process-wide state, so a test that changed it owes the next one a reset.
  setContainerRuntime(runtimeFor(DEFAULT_CONTAINER_RUNTIME_ID));
});

describe("the registry", () => {
  // `satisfies Record<ContainerRuntimeId, ContainerRuntime>` already makes a missing module a type
  // error. This is the runtime half of the same claim: that the ids the schema validates against
  // and the modules that implement them are the same set.
  it("has a module for every id the broker validates against", () => {
    expect(Object.keys(runtimes).sort()).toEqual([...CONTAINER_RUNTIME_IDS].sort());
    for (const id of CONTAINER_RUNTIME_IDS) {
      expect(runtimeFor(id).id).toBe(id);
    }
  });

  it("describes each engine's install routes, so a missing one is actionable", () => {
    for (const id of CONTAINER_RUNTIME_IDS) {
      expect(runtimeFor(id).cli.installers.length).toBeGreaterThan(0);
      expect(runtimeFor(id).cli.docsUrl).toMatch(/^https:\/\//);
    }
  });

  // Docker's client can be fine while the daemon is down; rootless Podman has no such gap. The
  // flag is what lets one message serve both without lying about either.
  it("records which engines have a daemon that can be down on its own", () => {
    expect(runtimeFor("docker").hasDaemon).toBe(true);
    expect(runtimeFor("podman").hasDaemon).toBe(false);
  });
});

describe("the active runtime", () => {
  it("is Docker until something says otherwise", () => {
    expect(containerRuntime().id).toBe("docker");
    expect(DEFAULT_CONTAINER_RUNTIME_ID).toBe("docker");
  });

  // The whole point of the registry: every subcommand warehousd issues is Docker's, and Podman
  // takes the same ones, so selecting an engine is selecting a binary name.
  it("changes which binary every subcommand is sent to", () => {
    setContainerRuntime(runtimeFor("podman"));
    vi.mocked(execFileSync).mockReturnValue("");

    run(["ps", "-a"]);

    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith("podman", ["ps", "-a"], expect.anything());
  });

  it("asks the selected engine for its version, not Docker's", () => {
    setContainerRuntime(runtimeFor("podman"));
    vi.mocked(execFileSync).mockReturnValue("5.2.0\n");

    expect(runtimeVersion()).toBe("5.2.0");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "podman",
      ["version", "--format", "{{.Server.Version}}"],
      expect.anything(),
    );
  });

  it("names the selected engine when it is missing, rather than the default one", () => {
    setContainerRuntime(runtimeFor("podman"));
    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error("spawn podman ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    // An explicit machine, so the suggested install line does not depend on the laptop running
    // the suite.
    expect(() => assertRuntime({ platform: "linux", env: { PATH: "" } })).toThrow(DockerError);
    expect(() => assertRuntime({ platform: "linux", env: { PATH: "" } })).toThrow(
      /podman not found on PATH/,
    );
  });
});
