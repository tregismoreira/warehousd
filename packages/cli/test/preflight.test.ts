import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));

import { execFileSync } from "node:child_process";
import {
  portIsFree,
  dockerCheck,
  configCheck,
  imageCheck,
  portCheck,
  containersCheck,
  runDoctor,
} from "../src/preflight";

let dir: string;

// Never a fixed port. A developer's own `warehousd start` binds 8722/8723, and a test that
// hardcodes them asserts something about that machine rather than about this code.
async function freePort(): Promise<number> {
  const srv = createServer();
  const port = await new Promise<number>((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
  });
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const CONFIG = `project: harbor
server:
  port: 8722
collections:
  a:
    description: d
    fields:
      id: { type: uuid, posture: allow, pk: true }
`;

/** The same config with both ports pointed somewhere nothing is listening. */
async function writeConfigOnFreePorts(): Promise<number> {
  const port = await freePort();
  writeFileSync(
    join(dir, "warehousd.yml"),
    CONFIG.replace("port: 8722", `port: ${port}`).replace(
      "collections:",
      `database:\n  port: ${await freePort()}\ncollections:`,
    ),
  );
  return port;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-pre-"));
  writeFileSync(join(dir, "warehousd.yml"), CONFIG);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("portIsFree", () => {
  it("is true for a port nothing holds", async () => {
    await expect(portIsFree(0)).resolves.toBe(true);
  });

  // The check `docker ps` cannot make: a plain listener, container or not.
  it("is false while something is listening", async () => {
    const srv: Server = createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        resolve((srv.address() as { port: number }).port);
      });
    });
    try {
      await expect(portIsFree(port)).resolves.toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("dockerCheck", () => {
  it("passes and reports the server version", () => {
    vi.mocked(execFileSync).mockReturnValue("29.6.2\n");
    const c = dockerCheck();
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("29.6.2");
  });

  it("fails with an instruction when the daemon is down", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Cannot connect");
    });
    const c = dockerCheck();
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Docker Desktop");
  });
});

describe("configCheck", () => {
  it("passes and counts collections", () => {
    const c = configCheck(dir);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("1 collection");
  });

  it("says to run init when there is no config", () => {
    rmSync(join(dir, "warehousd.yml"));
    const c = configCheck(dir);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("warehousd init");
  });

  it("reports a parse failure on one line", () => {
    writeFileSync(join(dir, "warehousd.yml"), "project: [unclosed\n");
    const c = configCheck(dir);
    expect(c.ok).toBe(false);
    expect(c.detail).not.toContain("\n");
  });
});

describe("imageCheck", () => {
  // The check the reported incident needed: name the image and say who chose it.
  it("names a local image and its source", () => {
    vi.mocked(execFileSync).mockReturnValue("");
    const c = imageCheck(dir, { WAREHOUSD_IMAGE: "warehousd:dev" });
    expect(c.detail).toContain("warehousd:dev");
    expect(c.detail).toContain("WAREHOUSD_IMAGE");
    expect(c.detail).toContain("present locally");
  });

  it("says a missing image will be pulled, and still names the source", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("No such image");
    });
    const c = imageCheck(dir, {});
    expect(c.detail).toContain("ghcr.io/tregismoreira/warehousd:");
    expect(c.detail).toContain("default");
    expect(c.detail).toContain("will be pulled");
  });

  it("fails rather than throws when the config cannot be read", () => {
    rmSync(join(dir, "warehousd.yml"));
    const c = imageCheck(dir, {});
    expect(c.ok).toBe(false);
  });
});

describe("portCheck", () => {
  it("passes when both ports are free", async () => {
    await writeConfigOnFreePorts();
    vi.mocked(execFileSync).mockReturnValue("");
    const checks = await portCheck(dir);
    expect(checks.map((c) => c.id)).toEqual(["port:server", "port:db"]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("skips the database port when the project brings its own Postgres", async () => {
    writeFileSync(
      join(dir, "warehousd.yml"),
      CONFIG.replace("server:", "database:\n  url: postgres://elsewhere/db\nserver:"),
    );
    vi.mocked(execFileSync).mockReturnValue("");
    const checks = await portCheck(dir);
    expect(checks.map((c) => c.id)).toEqual(["port:server"]);
  });

  // Our own container on the port is fine: recreating it is what `start` does.
  it("accepts this project's own container holding the port", async () => {
    const srv = createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
    });
    writeFileSync(join(dir, "warehousd.yml"), CONFIG.replace("port: 8722", `port: ${port}`));
    vi.mocked(execFileSync).mockReturnValue(`wh_harbor_server\t127.0.0.1:${port}->8722/tcp\n`);
    try {
      const checks = await portCheck(dir);
      expect(checks.find((c) => c.id === "port:server")?.ok).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("fails and names the foreign container holding the port", async () => {
    const srv = createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
    });
    writeFileSync(join(dir, "warehousd.yml"), CONFIG.replace("port: 8722", `port: ${port}`));
    vi.mocked(execFileSync).mockReturnValue(`someone_else\t127.0.0.1:${port}->8722/tcp\n`);
    try {
      const checks = await portCheck(dir);
      const server = checks.find((c) => c.id === "port:server");
      expect(server?.ok).toBe(false);
      expect(server?.detail).toContain("someone_else");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("fails with a different message when a non-container holds the port", async () => {
    const srv = createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
    });
    writeFileSync(join(dir, "warehousd.yml"), CONFIG.replace("port: 8722", `port: ${port}`));
    vi.mocked(execFileSync).mockReturnValue("");
    try {
      const checks = await portCheck(dir);
      const server = checks.find((c) => c.id === "port:server");
      expect(server?.ok).toBe(false);
      expect(server?.detail).toContain("not a container");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("containersCheck", () => {
  it("says to run start when there are none", () => {
    vi.mocked(execFileSync).mockReturnValue("");
    const { check, rows } = containersCheck(dir);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("warehousd start");
    expect(rows).toEqual([]);
  });

  it("passes when the server container is running", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "ps") return "wh_harbor_server\tUp 2 minutes\n";
      return "running";
    });
    const { check } = containersCheck(dir);
    expect(check.ok).toBe(true);
  });

  it("fails and points at the logs when the server is not running", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "ps") return "wh_harbor_server\tExited (1)\n";
      return "exited";
    });
    const { check } = containersCheck(dir);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("warehousd logs");
  });
});

describe("runDoctor", () => {
  it("runs every check and passes on a healthy stack", async () => {
    await writeConfigOnFreePorts();
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "version") return "29.6.2";
      if (a[0] === "ps") return "wh_harbor_server\tUp 2 minutes\n";
      if (a[0] === "inspect") return "running";
      return "";
    });
    const r = await runDoctor(dir);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual([
      "docker",
      "config",
      "image",
      "port:server",
      "port:db",
      "containers",
    ]);
  });

  // Every later check reads warehousd.yml, so running them against a broken one is only noise.
  it("stops after config when the config is unreadable", async () => {
    rmSync(join(dir, "warehousd.yml"));
    vi.mocked(execFileSync).mockReturnValue("29.6.2");
    const r = await runDoctor(dir);
    expect(r.ok).toBe(false);
    expect(r.checks.map((c) => c.id)).toEqual(["docker", "config"]);
  });

  it("stops after docker when the daemon is down", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Cannot connect");
    });
    const r = await runDoctor(dir);
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.id).toBe("docker");
    expect(r.checks.map((c) => c.id)).not.toContain("image");
  });
});
