import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import type { ExecFileSyncOptions } from "node:child_process";
import { runDeploy } from "../src/deploy";

// Mock child_process to control flyctl behavior
vi.mock("node:child_process");

describe("runDeploy", () => {
  let projectDir: string;
  let recordedCalls: { cmd: string; args: string[]; input?: string | undefined }[] = [];

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wh-deploy-"));
    recordedCalls = [];

    // Mock fetch for health polling
    global.fetch = vi.fn(() => Promise.resolve(new Response("OK", { status: 200 })));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("secrets travel via secrets import with payload in input option", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation(
      (cmd: string, args?: readonly string[], opts?: ExecFileSyncOptions) => {
        const argsArray = args ? Array.from(args) : [];
        const call: { cmd: string; args: string[]; input?: string | undefined } = {
          cmd,
          args: argsArray,
          input: typeof opts?.input === "string" ? opts.input : undefined,
        };
        recordedCalls.push(call);

        // Dispatch based on the first argument (the flyctl subcommand)
        const subcommand = argsArray[0];

        if (subcommand === "status") {
          // For appExists checks, make all apps exist by default
          return "App details...\n";
        } else if (subcommand === "apps") {
          if (argsArray[1] === "create") {
            return `Created app ${argsArray[2]}\n`;
          } else if (argsArray[1] === "destroy") {
            return `Destroyed ${argsArray[2]}\n`;
          }
        } else if (subcommand === "postgres") {
          if (argsArray[1] === "create") {
            return "Created postgres\n";
          } else if (argsArray[1] === "attach") {
            return "Attached postgres\n";
          }
        } else if (subcommand === "secrets") {
          return "Imported secrets\n";
        } else if (subcommand === "deploy") {
          return "Deployed\n";
        } else if (subcommand === "logs") {
          return "App logs here\n";
        } else if (subcommand === "version" || subcommand === "auth") {
          return "flyctl version 0.1.0\n";
        }

        return "";
      },
    );

    await runDeploy(projectDir, { yes: true, allowLocalLogin: true });

    // Find the secrets import call
    const secretsCall = recordedCalls.find(
      (c) => c.args[0] === "secrets" && c.args[1] === "import",
    );
    expect(secretsCall).toBeDefined();
    expect(secretsCall?.input).toBeDefined();

    // Verify no secret appears in argv (canary test)
    const canaryPassword = secretsCall?.input
      ?.split("\n")
      .find((l) => l.startsWith("WAREHOUSD_ADMIN_PASSWORD="))
      ?.split("=")[1];
    const allArgvs = JSON.stringify(recordedCalls.map((c) => c.args).flat());
    expect(allArgvs).not.toContain(canaryPassword);
  });

  it("sends the data-role password and no fabricated role URLs", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation(
      (cmd: string, args?: readonly string[], opts?: ExecFileSyncOptions) => {
        const argsArray = args ? Array.from(args) : [];
        recordedCalls.push({
          cmd,
          args: argsArray,
          input: typeof opts?.input === "string" ? opts.input : undefined,
        });

        const subcommand = argsArray[0];
        if (subcommand === "status") {
          return "App details...\n";
        } else if (subcommand === "apps") {
          return `Created app\n`;
        } else if (subcommand === "postgres") {
          return "Created postgres\n";
        } else if (subcommand === "secrets") {
          return "Imported secrets\n";
        } else if (subcommand === "deploy") {
          return "Deployed\n";
        } else if (subcommand === "version" || subcommand === "auth") {
          return "flyctl version 0.1.0\n";
        }
        return "";
      },
    );

    await runDeploy(projectDir, { yes: true, allowLocalLogin: true });

    const secretsCall = recordedCalls.find(
      (c) => c.args[0] === "secrets" && c.args[1] === "import",
    );
    const payload = secretsCall?.input ?? "";

    // The server derives the role URLs from these two (apps/web/app/lib/broker.ts). The password
    // must travel; the URLs must not.
    expect(payload).toContain("WAREHOUSD_DATA_ROLE_PASSWORD=");

    // An earlier version sent all four, built by handing dataRoleUrl the app's public HTTPS
    // address instead of the owner database URL — so every one of them was an `https://` string
    // that no Postgres driver could use. The previous assertions here passed anyway, because
    // `toContain("warehousd_dev")` is true of the broken value too.
    for (const key of [
      "DEV_DATABASE_URL",
      "LIVE_DATABASE_URL",
      "DEV_WRITE_DATABASE_URL",
      "LIVE_WRITE_DATABASE_URL",
    ]) {
      expect(payload).not.toContain(`${key}=`);
    }
    expect(payload).not.toContain("https://test-app.fly.dev/");

    // Managed Postgres: Fly owns the credentials and exposes them as DATABASE_URL, so inventing an
    // APP_DATABASE_URL here would ship a password that was generated for a local Docker container.
    expect(payload).not.toContain("APP_DATABASE_URL=");
  });

  it("WAREHOUSD_DISABLE_LOCAL_LOGIN=true by default", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    let secretsInput = "";
    vi.mocked(execFileSync).mockImplementation(
      (cmd: string, args?: readonly string[], opts?: ExecFileSyncOptions) => {
        const argsArray = args ? Array.from(args) : [];
        const subcommand = argsArray[0];
        if (subcommand === "secrets") {
          secretsInput = typeof opts?.input === "string" ? opts.input : "";
        }
        if (subcommand === "version" || subcommand === "auth" || subcommand === "status") {
          return "flyctl version 0.1.0\n";
        } else if (subcommand === "deploy") {
          return "Deployed\n";
        }
        return "";
      },
    );

    // Pre-flight refuses without SSO unless --allow-local-login, so the only way to reach the
    // secrets step with allowLocalLogin false is to have SSO configured — which is exactly the
    // deployment this default is for: SSO is the identity path, so local passwords go off.
    process.env.SSO_ISSUER = "https://idp.example.com";
    process.env.SSO_CLIENT_ID = "warehousd";
    process.env.SSO_CLIENT_SECRET = "shh";
    try {
      await runDeploy(projectDir, { yes: true });
    } finally {
      delete process.env.SSO_ISSUER;
      delete process.env.SSO_CLIENT_ID;
      delete process.env.SSO_CLIENT_SECRET;
    }

    expect(secretsInput).toContain("WAREHOUSD_DISABLE_LOCAL_LOGIN=true");
  });

  it("WAREHOUSD_DISABLE_LOCAL_LOGIN absent when allowLocalLogin: true", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    let secretsInput = "";
    vi.mocked(execFileSync).mockImplementation(
      (cmd: string, args?: readonly string[], opts?: ExecFileSyncOptions) => {
        const argsArray = args ? Array.from(args) : [];
        const subcommand = argsArray[0];
        if (subcommand === "secrets") {
          secretsInput = typeof opts?.input === "string" ? opts.input : "";
        }
        if (subcommand === "version" || subcommand === "auth" || subcommand === "status") {
          return "flyctl version 0.1.0\n";
        } else if (subcommand === "deploy") {
          return "Deployed\n";
        }
        return "";
      },
    );

    await runDeploy(projectDir, { yes: true, allowLocalLogin: true });

    expect(secretsInput).not.toContain("WAREHOUSD_DISABLE_LOCAL_LOGIN");
  });

  it("second run with appExists: true issues NO apps create or postgres create", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    let appsCreateCount = 0;
    let postgresCreateCount = 0;

    vi.mocked(execFileSync).mockImplementation(
      (cmd: string, args?: readonly string[], _opts?: ExecFileSyncOptions) => {
        const argsArray = args ? Array.from(args) : [];
        const subcommand = argsArray[0];
        if (subcommand === "apps" && argsArray[1] === "create") {
          appsCreateCount++;
        } else if (subcommand === "postgres" && argsArray[1] === "create") {
          postgresCreateCount++;
        }

        if (subcommand === "status") {
          return "App details...\n";
        } else if (subcommand === "version" || subcommand === "auth") {
          return "flyctl version 0.1.0\n";
        } else if (
          subcommand === "apps" ||
          subcommand === "postgres" ||
          subcommand === "secrets" ||
          subcommand === "deploy"
        ) {
          return "OK\n";
        }
        return "";
      },
    );

    // First run
    recordedCalls = [];
    await runDeploy(projectDir, { yes: true, allowLocalLogin: true });

    // Reset counts for second run
    appsCreateCount = 0;
    postgresCreateCount = 0;
    recordedCalls = [];

    // Second run should be idempotent
    await runDeploy(projectDir, { yes: true, allowLocalLogin: true });

    expect(appsCreateCount).toBe(0);
    expect(postgresCreateCount).toBe(0);
  });

  it("--remote-only present by default", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    let deployArgs: string[] = [];

    vi.mocked(execFileSync).mockImplementation(
      (cmd: string, args?: readonly string[], _opts?: ExecFileSyncOptions) => {
        const argsArray = args ? Array.from(args) : [];
        if (argsArray[0] === "deploy") {
          deployArgs = argsArray;
        }
        if (argsArray[0] === "version" || argsArray[0] === "auth" || argsArray[0] === "status") {
          return "flyctl version 0.1.0\n";
        }
        return "OK\n";
      },
    );

    await runDeploy(projectDir, { yes: true, allowLocalLogin: true });

    expect(deployArgs).toContain("--remote-only");
  });

  it("--remote-only absent with localBuild: true", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
deploy:
  target: fly
  app_name: test-app
  region: sea
  database:
    managed: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    let deployArgs: string[] = [];

    vi.mocked(execFileSync).mockImplementation(
      (cmd: string, args?: readonly string[], _opts?: ExecFileSyncOptions) => {
        const argsArray = args ? Array.from(args) : [];
        if (argsArray[0] === "deploy") {
          deployArgs = argsArray;
        }
        if (argsArray[0] === "version" || argsArray[0] === "auth" || argsArray[0] === "status") {
          return "flyctl version 0.1.0\n";
        }
        return "OK\n";
      },
    );

    // Mock docker assertion
    vi.doMock("../src/docker", () => ({
      assertDocker: vi.fn(),
    }));

    await runDeploy(projectDir, { yes: true, allowLocalLogin: true, localBuild: true });

    expect(deployArgs).not.toContain("--remote-only");
  });

  it("pre-flight failure issues NO mutating flyctl command", async () => {
    writeFileSync(
      join(projectDir, "warehousd.yml"),
      `
project: test
demo: true
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`,
    );

    const { execFileSync } = await import("node:child_process");
    const mutatingCommands: string[] = [];

    vi.mocked(execFileSync).mockImplementation(
      (cmd: string, args?: readonly string[], _opts?: ExecFileSyncOptions) => {
        const argsArray = args ? Array.from(args) : [];
        const subcommand = argsArray[0];
        if (subcommand && ["apps", "postgres", "secrets", "deploy"].includes(subcommand)) {
          mutatingCommands.push(subcommand);
        }
        if (subcommand === "version" || subcommand === "auth") {
          return "flyctl version 0.1.0\n";
        }
        return "";
      },
    );

    // Stub process.exit
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    try {
      await runDeploy(projectDir, { yes: true, allowLocalLogin: true });
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message === "exit")) {
        throw err;
      }
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mutatingCommands).toHaveLength(0);

    exitSpy.mockRestore();
  });
});
