import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { loadConfig, DEPLOY_TARGET_IDS } from "@warehousd/broker";
import { targets, targetFor } from "../src/deploy/targets";

vi.mock("node:child_process");

function projectYaml(region: string): string {
  return `
project: test
deploy:
  target: fly
  app_name: test-app
  region: ${region}
  database:
    managed: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`;
}

describe("the deploy target registry", () => {
  // The `satisfies Record<DeployTargetId, DeployTarget>` in deploy/targets/index.ts already refuses
  // to compile if the two lists disagree. This is the same question asked at runtime, because the
  // list is also what `z.enum` validates warehousd.yml against: a target id nobody registered would
  // pass config parsing and then fail at `targetFor`.
  it("registers exactly the ids DeploySchema accepts", () => {
    expect(Object.keys(targets).sort()).toEqual([...DEPLOY_TARGET_IDS].sort());
  });

  it("every registered target answers to its own id and has a label", () => {
    for (const id of DEPLOY_TARGET_IDS) {
      const target = targetFor(id);
      expect(target.id).toBe(id);
      expect(target.label.length).toBeGreaterThan(0);
    }
  });
});

describe("the fly target's pre-flight", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "wh-target-"));
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockReturnValue("flyctl version 0.1.0\n");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  // DeploySchema used to carry `/^[a-z]{3}$/`, so this config could not be loaded at all and the
  // operator got a zod issue naming a line number. The shape of a region is the target's business
  // now, and this is where the refusal has to come from instead.
  it("refuses a region that is not a Fly region code", async () => {
    writeFileSync(join(projectDir, "warehousd.yml"), projectYaml("brazil"));
    const cfg = loadConfig(projectDir);

    const checks = await targetFor("fly").preflight({ projectDir, cfg, env: {} });

    const region = checks.find((c) => c.id === "fly-region");
    expect(region?.ok).toBe(false);
    expect(region?.detail).toContain("brazil");
    expect(region?.detail).toContain("three letters");
  });

  it("accepts a three-letter region", async () => {
    writeFileSync(join(projectDir, "warehousd.yml"), projectYaml("gru"));
    const cfg = loadConfig(projectDir);

    const checks = await targetFor("fly").preflight({ projectDir, cfg, env: {} });

    expect(checks.find((c) => c.id === "fly-region")?.ok).toBe(true);
  });

  // A project that has never deployed has no region to judge, and a permanent "not evaluated" line
  // on every `warehousd doctor` run would stand where a real answer should be.
  it("says nothing about the region when there is no deploy block", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );
    const cfg = loadConfig(projectDir);

    const checks = await targetFor("fly").preflight({ projectDir, cfg, env: {} });

    expect(checks.map((c) => c.id)).toEqual(["flyctl-ready"]);
  });

  it("reports flyctl as missing without a deploy block or a loadable config", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const checks = await targetFor("fly").preflight({ projectDir, cfg: null, env: {} });

    const fly = checks.find((c) => c.id === "flyctl-ready");
    expect(fly?.ok).toBe(false);
    expect(fly?.detail).toContain("install");
  });
});
