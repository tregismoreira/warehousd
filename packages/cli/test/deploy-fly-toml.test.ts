import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderDeployDockerfile, renderFlyToml, resolveBaseImage } from "../src/deploy/fly-toml";
import { loadConfig } from "@warehousd/broker";

describe("renderDeployDockerfile", () => {
  it("contains the exact Dockerfile structure with --chown=node:node", () => {
    const dockerfile = renderDeployDockerfile("ghcr.io/example/image:latest");
    expect(dockerfile).toContain("FROM ghcr.io/example/image:latest");
    expect(dockerfile).toContain("--chown=node:node");
    expect(dockerfile).toContain("context /project");
  });

  it("includes the base image in FROM statement", () => {
    const baseImage = "myregistry.io/custom:v1.2.3";
    const dockerfile = renderDeployDockerfile(baseImage);
    expect(dockerfile).toContain(`FROM ${baseImage}`);
  });

  it("produces valid multi-line Dockerfile", () => {
    const dockerfile = renderDeployDockerfile("test-image:tag");
    const lines = dockerfile.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe("FROM test-image:tag");
    expect(lines[1]).toBe("COPY --chown=node:node context /project");
  });
});

describe("renderFlyToml", () => {
  it("contains force_https = true", () => {
    const toml = renderFlyToml({ appName: "my-app", region: "sea" });
    expect(toml).toContain("force_https = true");
  });

  it("contains the release_command line", () => {
    const toml = renderFlyToml({ appName: "my-app", region: "sea" });
    expect(toml).toContain('release_command = "pnpm tsx apps/web/scripts/entrypoint.ts"');
  });

  it("contains the [processes] override", () => {
    const toml = renderFlyToml({ appName: "my-app", region: "sea" });
    expect(toml).toContain("[processes]");
    expect(toml).toContain('app = "pnpm --filter @warehousd/web start"');
  });

  it("does NOT contain WAREHOUSD_DEMO", () => {
    const toml = renderFlyToml({ appName: "my-app", region: "sea" });
    expect(toml).not.toContain("WAREHOUSD_DEMO");
  });

  it("includes the app name in output", () => {
    const toml = renderFlyToml({ appName: "test-app-name", region: "ord" });
    expect(toml).toContain('app = "test-app-name"');
  });

  it("includes the region in output", () => {
    const toml = renderFlyToml({ appName: "test-app", region: "lhr" });
    expect(toml).toContain('primary_region = "lhr"');
  });

  it("includes all required env vars", () => {
    const toml = renderFlyToml({ appName: "test-app", region: "sea" });
    expect(toml).toContain('PORT = "8722"');
    expect(toml).toContain('WAREHOUSD_PROJECT_DIR = "/project"');
    expect(toml).toContain('NODE_ENV = "production"');
  });

  it("includes http_service configuration", () => {
    const toml = renderFlyToml({ appName: "test-app", region: "sea" });
    expect(toml).toContain("[http_service]");
    expect(toml).toContain("internal_port = 8722");
    expect(toml).toContain('auto_stop_machines = "suspend"');
    expect(toml).toContain("min_machines_running = 1");
  });

  it("includes build configuration", () => {
    const toml = renderFlyToml({ appName: "test-app", region: "sea" });
    expect(toml).toContain("[build]");
    expect(toml).toContain('dockerfile = "Dockerfile"');
  });

  it("includes deploy configuration", () => {
    const toml = renderFlyToml({ appName: "test-app", region: "sea" });
    expect(toml).toContain("[deploy]");
  });
});

describe("resolveBaseImage", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `warehousd-resolve-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("prefers cfg.deploy.image if present", () => {
    writeFileSync(
      join(testDir, "warehousd.yml"),
      `
project: test
server: { port: 8722 }
collections: {}
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
  image: custom-registry.io/custom-image:v1.0
`,
    );

    const cfg = loadConfig(testDir);
    const image = resolveBaseImage(cfg);
    expect(image).toBe("custom-registry.io/custom-image:v1.0");
  });

  it("prefers process.env.WAREHOUSD_IMAGE over default", () => {
    writeFileSync(
      join(testDir, "warehousd.yml"),
      `
project: test
server: { port: 8722 }
collections: {}
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
`,
    );

    const originalEnv = process.env.WAREHOUSD_IMAGE;
    try {
      process.env.WAREHOUSD_IMAGE = "env-override.io/image:tag";
      const cfg = loadConfig(testDir);
      const image = resolveBaseImage(cfg);
      expect(image).toBe("env-override.io/image:tag");
    } finally {
      if (originalEnv) {
        process.env.WAREHOUSD_IMAGE = originalEnv;
      } else {
        delete process.env.WAREHOUSD_IMAGE;
      }
    }
  });

  it("falls back to IMAGE_REPO default when nothing else is set", () => {
    writeFileSync(
      join(testDir, "warehousd.yml"),
      `
project: test
server: { port: 8722 }
collections: {}
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
`,
    );

    const originalEnv = process.env.WAREHOUSD_IMAGE;
    try {
      delete process.env.WAREHOUSD_IMAGE;
      const cfg = loadConfig(testDir);
      const image = resolveBaseImage(cfg);
      // Should include IMAGE_REPO and either a version or 'latest'
      expect(image).toContain("ghcr.io/tregismoreira/warehousd");
      expect(image).toMatch(/:(latest|[\d.]+)$/);
    } finally {
      if (originalEnv) {
        process.env.WAREHOUSD_IMAGE = originalEnv;
      }
    }
  });

  it("resolves with database.url instead of managed", () => {
    writeFileSync(
      join(testDir, "warehousd.yml"),
      `
project: test
server: { port: 8722 }
collections: {}
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    url: postgres://user:pass@host/db
  image: explicit-image:tag
`,
    );

    const cfg = loadConfig(testDir);
    const image = resolveBaseImage(cfg);
    expect(image).toBe("explicit-image:tag");
  });

  it("cfg.deploy.image takes precedence over process.env.WAREHOUSD_IMAGE", () => {
    writeFileSync(
      join(testDir, "warehousd.yml"),
      `
project: test
server: { port: 8722 }
collections: {}
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
  image: cfg-image:v1
`,
    );

    const originalEnv = process.env.WAREHOUSD_IMAGE;
    try {
      process.env.WAREHOUSD_IMAGE = "env-image:v2";
      const cfg = loadConfig(testDir);
      const image = resolveBaseImage(cfg);
      // cfg.deploy.image should win
      expect(image).toBe("cfg-image:v1");
    } finally {
      if (originalEnv) {
        process.env.WAREHOUSD_IMAGE = originalEnv;
      } else {
        delete process.env.WAREHOUSD_IMAGE;
      }
    }
  });

  it("process.env.WAREHOUSD_IMAGE takes precedence over default", () => {
    writeFileSync(
      join(testDir, "warehousd.yml"),
      `
project: test
server: { port: 8722 }
collections: {}
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
`,
    );

    const originalEnv = process.env.WAREHOUSD_IMAGE;
    try {
      process.env.WAREHOUSD_IMAGE = "priority-env:tag";
      const cfg = loadConfig(testDir);
      const image = resolveBaseImage(cfg);
      expect(image).toBe("priority-env:tag");
    } finally {
      if (originalEnv) {
        process.env.WAREHOUSD_IMAGE = originalEnv;
      } else {
        delete process.env.WAREHOUSD_IMAGE;
      }
    }
  });
});
