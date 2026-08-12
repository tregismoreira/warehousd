import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createCalls: any[] = [];
const listCalls: number[] = [];
const revokeCalls: string[] = [];

// The gate (`assertEnabled`) and the managedWorkspaces shaping are the parts of this command
// worth a unit test — both run before any query does, so the database is mocked out rather than
// provisioned. `createPlatformKey`/`listPlatformKeys`/`revokePlatformKey` themselves are exercised
// against a real database already, in apps/web/test/platform-api.integration.test.ts.
vi.mock("@warehousd/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@warehousd/broker")>();
  return {
    ...actual,
    createPlatformKey: vi.fn((_db: unknown, i: unknown) => {
      createCalls.push(i);
      return Promise.resolve({ secret: "whd_plat_fake_x_y", id: "fakeid" });
    }),
    listPlatformKeys: vi.fn(() => {
      listCalls.push(1);
      return Promise.resolve([]);
    }),
    revokePlatformKey: vi.fn((_db: unknown, id: string) => {
      revokeCalls.push(id);
      return Promise.resolve(true);
    }),
  };
});

import {
  runPlatformKeyCreate,
  runPlatformKeyList,
  runPlatformKeyRevoke,
  PlatformDisabledError,
} from "../src/commands/platform-key";

let dir: string;

function writeConfig(enabled: boolean) {
  writeFileSync(
    join(dir, "warehousd.yml"),
    `project: t\nserver: { port: 1 }\nworkspaces: { enabled: ${enabled} }\ncollections: {}\n`,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-platform-key-"));
  createCalls.length = 0;
  listCalls.length = 0;
  revokeCalls.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("platform-key: workspaces.enabled gate", () => {
  it("create refuses before ever touching the database", async () => {
    writeConfig(false);
    await expect(
      runPlatformKeyCreate(dir, "postgres://ignored/ignored", {
        label: "x",
        allWorkspaces: true,
        days: 90,
      }),
    ).rejects.toThrow(PlatformDisabledError);
    expect(createCalls).toHaveLength(0);
  });

  it("list and revoke refuse the same way", async () => {
    writeConfig(false);
    await expect(runPlatformKeyList(dir, "postgres://ignored/ignored")).rejects.toThrow(
      PlatformDisabledError,
    );
    await expect(runPlatformKeyRevoke(dir, "postgres://ignored/ignored", "k1")).rejects.toThrow(
      PlatformDisabledError,
    );
    expect(listCalls).toHaveLength(0);
    expect(revokeCalls).toHaveLength(0);
  });
});

describe("platform-key create: --all-workspaces vs --workspaces", () => {
  it("--all-workspaces sends managedWorkspaces: null, ignoring any --workspaces list", async () => {
    writeConfig(true);
    await runPlatformKeyCreate(dir, "postgres://ignored/ignored", {
      label: "x",
      allWorkspaces: true,
      workspaces: ["should-be-ignored"],
      days: 90,
    });
    expect(createCalls[0].managedWorkspaces).toBeNull();
  });

  it("--workspaces a,b sends the parsed array unchanged", async () => {
    writeConfig(true);
    await runPlatformKeyCreate(dir, "postgres://ignored/ignored", {
      label: "x",
      allWorkspaces: false,
      workspaces: ["a", "b"],
      days: 90,
    });
    expect(createCalls[0].managedWorkspaces).toEqual(["a", "b"]);
  });

  it("neither flag sends an empty array, not null", async () => {
    writeConfig(true);
    await runPlatformKeyCreate(dir, "postgres://ignored/ignored", {
      label: "x",
      allWorkspaces: false,
      days: 90,
    });
    expect(createCalls[0].managedWorkspaces).toEqual([]);
  });

  it("expiresAt lands `days` days out from now", async () => {
    writeConfig(true);
    const before = Date.now();
    await runPlatformKeyCreate(dir, "postgres://ignored/ignored", {
      label: "x",
      allWorkspaces: true,
      days: 10,
    });
    const expiresAt = createCalls[0].expiresAt as Date;
    const deltaDays = (expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeGreaterThan(9.99);
    expect(deltaDays).toBeLessThan(10.01);
  });
});
