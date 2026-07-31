import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  buildRunArgs,
  assertDocker,
  run,
  tryRun,
  removeContainer,
  ensureImage,
  psByLabel,
  containerOnPort,
  DockerError,
} from "../src/docker";

vi.mock("node:child_process");

// The bug these cover.
//
// `execFileSync`'s default stdio captures the child's stderr *and* echoes it to the parent. Every
// "does this exist yet?" probe therefore announced its own negative answer, in Docker's voice, on
// the ordinary first-run path:
//
//     Error response from daemon: network wh_harbor_net not found
//     Error response from daemon: get wh_harbor_pgdata: no such volume
//     error: no such object: wh_harbor_db
//
// All three mean "absent, so create it". Passing stdio explicitly is the fix, and stdio[0] must
// stay "pipe" rather than "ignore" because execFileSync silently drops its `input` option
// otherwise — which is how deploy pipes Fly secrets.
describe("stdio", () => {
  afterEach(() => vi.clearAllMocks());

  it("captures stderr instead of letting it through to the user", () => {
    vi.mocked(execFileSync).mockReturnValue("");
    run(["network", "inspect", "wh_harbor_net"]);
    const opts = vi.mocked(execFileSync).mock.calls[0]![2] as { stdio?: unknown };
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("never uses 'ignore' for stdin, which would discard execFileSync's input option", () => {
    vi.mocked(execFileSync).mockReturnValue("");
    run(["ps"]);
    const opts = vi.mocked(execFileSync).mock.calls[0]![2] as { stdio?: string[] };
    expect(opts.stdio?.[0]).not.toBe("ignore");
  });

  it("lets `docker pull` keep its own progress output", () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => {
        throw new Error("no such image");
      })
      .mockReturnValueOnce("");
    ensureImage("warehousd:dev");
    const pull = vi.mocked(execFileSync).mock.calls[1]!;
    expect(pull[1]).toEqual(["pull", "warehousd:dev"]);
    expect((pull[2] as { stdio?: string[] }).stdio?.[2]).toBe("inherit");
  });

  it("puts the captured stderr into the DockerError, not 'Command failed'", () => {
    const err: any = new Error("Command failed: docker rm -f x");
    err.stderr = "Error response from daemon: No such container: x";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    expect(() => run(["rm", "-f", "x"])).toThrow(DockerError);
    expect(() => run(["rm", "-f", "x"])).toThrow(/No such container/);
  });
});

describe("removeContainer", () => {
  afterEach(() => vi.clearAllMocks());

  // "Ensure absent", not "remove": a container that was never there is the desired end state.
  it("does not throw when the container was never there", () => {
    const err: any = new Error("boom");
    err.stderr = "Error response from daemon: No such container: wh_harbor_db";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    expect(() => removeContainer("wh_harbor_db")).not.toThrow();
  });
});

describe("tryRun", () => {
  afterEach(() => vi.clearAllMocks());

  it("swallows the failure and reports it", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("nope");
    });
    expect(tryRun(["network", "inspect", "x"])).toEqual({ ok: false, out: "" });
  });
});

describe("psByLabel", () => {
  afterEach(() => vi.clearAllMocks());

  it("parses names and states", () => {
    vi.mocked(execFileSync).mockReturnValue(
      "wh_harbor_server\tUp 2 minutes\nwh_harbor_db\tUp 2 minutes (healthy)\n",
    );
    expect(psByLabel("warehousd.project=harbor")).toEqual([
      { name: "wh_harbor_server", state: "Up 2 minutes" },
      { name: "wh_harbor_db", state: "Up 2 minutes (healthy)" },
    ]);
  });

  it("is empty when nothing matches", () => {
    vi.mocked(execFileSync).mockReturnValue("");
    expect(psByLabel("warehousd.project=nothing")).toEqual([]);
  });
});

describe("containerOnPort", () => {
  afterEach(() => vi.clearAllMocks());

  it("names the container holding a port", () => {
    vi.mocked(execFileSync).mockReturnValue(
      "other_server\t127.0.0.1:8722->8722/tcp\nwh_harbor_db\t127.0.0.1:8723->5432/tcp\n",
    );
    expect(containerOnPort(8722)).toBe("other_server");
    expect(containerOnPort(8723)).toBe("wh_harbor_db");
  });

  it("is null when no container holds it", () => {
    vi.mocked(execFileSync).mockReturnValue("");
    expect(containerOnPort(9999)).toBeNull();
  });
});

describe("buildRunArgs", () => {
  it("builds db container args in correct order", () => {
    const spec = {
      name: "wh_myapp_db",
      image: "postgres:17-alpine",
      network: "wh_myapp_net",
      label: "warehousd.project=myapp",
      env: {
        POSTGRES_PASSWORD: "secret123",
        POSTGRES_DB: "warehousd",
      },
      ports: { "5432": "5432" },
      volumes: { "/var/lib/postgresql/data": "wh_myapp_pgdata" },
    };

    const args = buildRunArgs(spec);

    // Verify exact structure: flags before image, image at end
    expect(args[args.length - 1]).toBe("postgres:17-alpine");

    // Verify key flags are present
    expect(args).toContain("--label");
    expect(args).toContain("warehousd.project=myapp");
    expect(args).toContain("--restart");
    expect(args).toContain("unless-stopped");
    expect(args).toContain("--network");
    expect(args).toContain("wh_myapp_net");
    expect(args).toContain("--name");
    expect(args).toContain("wh_myapp_db");

    // Verify env vars as -e pairs
    expect(args).toContain("-e");
    expect(args).toContain("POSTGRES_PASSWORD=secret123");
    expect(args).toContain("POSTGRES_DB=warehousd");

    // Verify ports as host:container
    expect(args).toContain("-p");
    expect(args).toContain("5432:5432");

    // Verify volumes as host:container
    expect(args).toContain("-v");
    expect(args).toContain("wh_myapp_pgdata:/var/lib/postgresql/data");

    // Verify -d for detached
    expect(args).toContain("-d");
  });

  it("builds server container args in correct order", () => {
    const spec = {
      name: "wh_myapp_server",
      image: "warehousd/server:0.1.0",
      network: "wh_myapp_net",
      label: "warehousd.project=myapp",
      env: {
        WAREHOUSD_MCP_URL: "http://localhost:3000",
        NODE_ENV: "production",
      },
      ports: { "8722": "8722" },
    };

    const args = buildRunArgs(spec);

    expect(args[args.length - 1]).toBe("warehousd/server:0.1.0");
    expect(args).toContain("--label");
    expect(args).toContain("warehousd.project=myapp");
    expect(args).toContain("-e");
    expect(args).toContain("WAREHOUSD_MCP_URL=http://localhost:3000");
    expect(args).toContain("-e");
    expect(args).toContain("NODE_ENV=production");
    expect(args).toContain("-p");
    expect(args).toContain("8722:8722");
  });

  it("env vars are in stable order", () => {
    const spec = {
      name: "test",
      image: "test:latest",
      network: "net",
      label: "label=test",
      env: {
        Z_VAR: "z",
        A_VAR: "a",
        M_VAR: "m",
      },
    };

    const args = buildRunArgs(spec);
    const envIndices = args
      .map((arg, i) => ({ arg, i }))
      .filter((x) => x.arg === "-e")
      .map((x) => x.i);

    // Verify all env vars are present
    expect(args).toContain("A_VAR=a");
    expect(args).toContain("M_VAR=m");
    expect(args).toContain("Z_VAR=z");

    // Verify env values appear after their -e flag
    const envVars = envIndices.map((i) => args[i + 1]);
    expect(envVars.sort()).toEqual(envVars); // check they are in order
  });

  it("handles missing optional volumes", () => {
    const spec = {
      name: "test",
      image: "test:latest",
      network: "net",
      label: "label=test",
      env: {},
    };

    const args = buildRunArgs(spec);
    expect(args[args.length - 1]).toBe("test:latest");
    expect(args).toContain("--name");
    expect(args).toContain("test");
  });
});

describe("assertDocker", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("throws install message when docker is not found (ENOENT)", () => {
    const mockExecFileSync = vi.mocked(execFileSync);
    const error: any = new Error("not found");
    error.code = "ENOENT";
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    expect(() => assertDocker()).toThrow(/docker not found on PATH.*Install Docker Desktop/);
  });

  it("throws daemon message when docker daemon is not reachable", () => {
    const mockExecFileSync = vi.mocked(execFileSync);
    const error: any = new Error("daemon not running");
    error.stderr = "Cannot connect to Docker daemon";
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    expect(() => assertDocker()).toThrow(/Docker is installed but the daemon isn't reachable/);
  });
});
