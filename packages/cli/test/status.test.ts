import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "") }));

import { execFileSync } from "node:child_process";
import { runStatus } from "../src/status";

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
  dir = mkdtempSync(join(tmpdir(), "wh-status-"));
  writeFileSync(join(dir, "warehousd.yml"), CONFIG);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function containersUp() {
  vi.mocked(execFileSync).mockReturnValue("wh_harbor_server\tUp 2 minutes\n");
}

describe("runStatus", () => {
  it("reports nothing running when the project has no containers", async () => {
    vi.mocked(execFileSync).mockReturnValue("");
    const r = await runStatus(dir);
    expect(r.containers).toEqual([]);
    expect(r.healthy).toBe(false);
    expect(r.project).toBe("harbor");
  });

  // The bug this covers: `status` health-checked only when outputs.json existed, so a checkout
  // without that file reported a perfectly healthy stack as "not responding" — blaming the server
  // for a missing local file. The port is in warehousd.yml either way.
  it("health-checks the configured port when outputs.json is absent", async () => {
    containersUp();
    const fetchMock = vi.fn((_url: string) => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    const r = await runStatus(dir);

    expect(r.outputs).toBeNull();
    expect(r.healthy).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8722/api/health");
  });

  it("prefers the apiUrl from outputs.json when it is there", async () => {
    containersUp();
    mkdirSync(join(dir, ".warehousd"), { recursive: true });
    writeFileSync(
      join(dir, ".warehousd", "outputs.json"),
      JSON.stringify({
        mcpUrl: "http://localhost:9001/mcp",
        apiUrl: "http://localhost:9001",
        adminUrl: "http://localhost:9001/admin",
        databaseUrl: "postgres://warehousd:pw@localhost:9002/warehousd",
        env: "dev",
        devClient: { clientId: "c", clientSecret: "s" },
      }),
    );
    const fetchMock = vi.fn((_url: string) => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    const r = await runStatus(dir);

    expect(r.healthy).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:9001/api/health");
  });

  it("is unhealthy, not hung, when the server does not answer", async () => {
    containersUp();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const r = await runStatus(dir);
    expect(r.healthy).toBe(false);
    expect(r.containers).toHaveLength(1);
  });
});
