import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { loadConfig, type WarehousdConfig } from "@warehousd/broker";
import { targetFor } from "../src/deploy/targets";
import { renderRailwayJson } from "../src/deploy/targets/railway";
import type { TargetContext } from "../src/deploy/targets";

vi.mock("node:child_process");

const railway = targetFor("railway");

function projectYaml(o: { region: string; managed: boolean }): string {
  return `
project: test
deploy:
  target: railway
  app_name: harbor-warehousd
  region: ${o.region}
  image: ghcr.io/example/warehousd:test
  database:
    ${o.managed ? "managed: true" : "url: postgres://u:p@example.com:5432/db"}
collections:
  docs:
    description: Docs
    fields:
      title:
        type: text
        posture: allow
`;
}

/**
 * Every railway invocation the test has seen, as a joined string per call — assertions read
 * `calls()` rather than indexes so they do not depend on how many probes a method happens to make.
 */
function calls(): string[] {
  return vi
    .mocked(execFileSyncRef)
    .mock.calls.map((call) => (Array.isArray(call[1]) ? (call[1] as string[]).join(" ") : ""));
}

// Bound in beforeEach; `vi.mock` hoists above the import, so the reference is resolved lazily.
let execFileSyncRef: typeof import("node:child_process").execFileSync;

/** Answers keyed on `<subcommand>`, so a method's probes and its mutations can differ. */
function onSubcommand(handlers: Record<string, () => string>) {
  vi.mocked(execFileSyncRef).mockImplementation(
    (_file: string, args?: readonly string[] | object) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      const handler = handlers[argv[0] ?? ""];
      if (!handler) throw new Error(`unexpected railway ${argv.join(" ")}`);
      return handler();
    },
  );
}

function status(o: { name: string; services: string[] }): string {
  return JSON.stringify({
    name: o.name,
    services: { edges: o.services.map((name) => ({ node: { name } })) },
  });
}

let projectDir: string;
let said: string[];

function context(cfg: WarehousdConfig): TargetContext {
  const deployDir = join(projectDir, ".warehousd", "deploy");
  mkdirSync(deployDir, { recursive: true });
  return {
    projectDir,
    cfg,
    deploy: cfg.deploy!,
    appName: cfg.deploy!.app_name,
    region: cfg.deploy!.region,
    state: null,
    deployDir,
    contextDir: join(deployDir, "context"),
    localBuild: false,
    say: (msg) => said.push(msg),
  };
}

function load(o: { region?: string; managed?: boolean } = {}): WarehousdConfig {
  writeFileSync(
    join(projectDir, "warehousd.yml"),
    projectYaml({ region: o.region ?? "us-west2", managed: o.managed ?? true }),
  );
  return loadConfig(projectDir);
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "wh-railway-"));
  said = [];
  ({ execFileSync: execFileSyncRef } = await import("node:child_process"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("the railway target's pre-flight", () => {
  it("accepts a Railway region code", async () => {
    onSubcommand({ "--version": () => "railway 4.0.0", whoami: () => "me", status: () => "" });

    const checks = await railway.preflight({
      projectDir,
      cfg: load({ region: "us-west2" }),
      env: {},
    });

    expect(checks.find((c) => c.id === "railway-region")?.ok).toBe(true);
  });

  it("accepts a region with a metal suffix", async () => {
    onSubcommand({ "--version": () => "railway 4.0.0", whoami: () => "me", status: () => "" });

    const checks = await railway.preflight({
      projectDir,
      cfg: load({ region: "europe-west4-drams3a" }),
      env: {},
    });

    expect(checks.find((c) => c.id === "railway-region")?.ok).toBe(true);
  });

  // Fly's three-letter slug is the shape this target must NOT accept — it is the whole reason
  // region validation left DeploySchema (PR 3) instead of being widened there.
  it("refuses a Fly region code", async () => {
    onSubcommand({ "--version": () => "railway 4.0.0", whoami: () => "me", status: () => "" });

    const checks = await railway.preflight({ projectDir, cfg: load({ region: "gru" }), env: {} });

    const region = checks.find((c) => c.id === "railway-region");
    expect(region?.ok).toBe(false);
    expect(region?.detail).toContain("gru");
    expect(region?.detail).toContain("us-west2");
  });

  it("reports the CLI as missing without a loadable config", async () => {
    vi.mocked(execFileSyncRef).mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const checks = await railway.preflight({ projectDir, cfg: null, env: {} });

    const ready = checks.find((c) => c.id === "railway-ready");
    expect(ready?.ok).toBe(false);
    expect(ready?.detail).toContain("@railway/cli");
    // Nothing else is answerable with no config, and a page of "not evaluated" lines stands where
    // a real answer should be.
    expect(checks.map((c) => c.id)).toEqual(["railway-ready"]);
  });

  it("passes when nothing is linked yet, which is what a first deploy looks like", async () => {
    onSubcommand({
      "--version": () => "railway 4.0.0",
      whoami: () => "me",
      status: () => {
        throw new Error("No linked project found");
      },
    });

    const checks = await railway.preflight({ projectDir, cfg: load(), env: {} });

    const project = checks.find((c) => c.id === "railway-project");
    expect(project?.ok).toBe(true);
    expect(project?.detail).toContain("harbor-warehousd");
  });

  // The one thing that can silently ship a deploy somewhere the config does not name: `railway up`
  // takes the linked project, and never mentions app_name.
  it("refuses when the directory is linked to a different project", async () => {
    onSubcommand({
      "--version": () => "railway 4.0.0",
      whoami: () => "me",
      status: () => status({ name: "someone-elses-project", services: [] }),
    });

    const checks = await railway.preflight({ projectDir, cfg: load(), env: {} });

    const project = checks.find((c) => c.id === "railway-project");
    expect(project?.ok).toBe(false);
    expect(project?.detail).toContain("someone-elses-project");
    expect(project?.detail).toContain("railway unlink");
  });

  it("issues no mutating railway command", async () => {
    onSubcommand({
      "--version": () => "railway 4.0.0",
      whoami: () => "me",
      status: () => status({ name: "harbor-warehousd", services: [] }),
    });

    await railway.preflight({ projectDir, cfg: load(), env: {} });

    for (const call of calls()) {
      expect(call).not.toMatch(/^(init|add|up|variables|domain|delete|down)\b/);
    }
  });
});

describe("ensureApp", () => {
  it("creates the project and its service on a first deploy", async () => {
    let linked = false;
    onSubcommand({
      status: () => {
        if (!linked) throw new Error("No linked project found");
        return status({ name: "harbor-warehousd", services: [] });
      },
      init: () => {
        linked = true;
        return "created";
      },
      add: () => "service created",
    });

    await railway.ensureApp(context(load()));

    expect(calls()).toContain("init --name harbor-warehousd");
    // `railway init` links an empty project, and `railway up` against one with no service prompts
    // for which — a prompt is a hang, or a failure, on a deploy's closed stdin.
    expect(calls()).toContain("add --service harbor-warehousd");
  });

  it("is idempotent: a redeploy creates neither", async () => {
    onSubcommand({
      status: () => status({ name: "harbor-warehousd", services: ["harbor-warehousd"] }),
    });

    await railway.ensureApp(context(load()));

    expect(calls().filter((c) => c.startsWith("init") || c.startsWith("add"))).toEqual([]);
  });
});

describe("provisionDatabase", () => {
  it("adds Postgres and returns the URL Railway injected", async () => {
    let added = false;
    onSubcommand({
      status: () =>
        status({
          name: "harbor-warehousd",
          services: added ? ["harbor-warehousd", "Postgres"] : ["harbor-warehousd"],
        }),
      add: () => {
        added = true;
        return "added";
      },
      variables: () =>
        JSON.stringify({
          DATABASE_URL: "postgres://postgres:pw@postgres.railway.internal:5432/railway",
          DATABASE_PUBLIC_URL: "postgres://postgres:pw@shinkansen.proxy.rlwy.net:1234/railway",
        }),
    });

    const url = await railway.provisionDatabase!(context(load()));

    expect(calls()).toContain("add --database postgres");
    // The private hostname, because the app runs inside the same project: it skips the public
    // proxy and its egress. Both spellings are a Railway Postgres to the provider registry.
    expect(url).toBe("postgres://postgres:pw@postgres.railway.internal:5432/railway");
  });

  it("falls back to the public URL when there is no private one", async () => {
    onSubcommand({
      status: () => status({ name: "harbor-warehousd", services: ["Postgres"] }),
      variables: () =>
        JSON.stringify({
          DATABASE_PUBLIC_URL: "postgres://postgres:pw@shinkansen.proxy.rlwy.net:1234/railway",
        }),
    });

    const url = await railway.provisionDatabase!(context(load()));

    expect(url).toBe("postgres://postgres:pw@shinkansen.proxy.rlwy.net:1234/railway");
  });

  it("does not add a second Postgres on a redeploy", async () => {
    onSubcommand({
      status: () =>
        status({ name: "harbor-warehousd", services: ["harbor-warehousd", "Postgres"] }),
      variables: () => JSON.stringify({ DATABASE_URL: "postgres://u:p@h:5432/railway" }),
    });

    await railway.provisionDatabase!(context(load()));

    expect(calls()).not.toContain("add --database postgres");
  });

  // Provisioning is asynchronous on Railway's side: `railway add` returns once the request is
  // accepted, and the variables are empty until the database actually exists. Reading once meant a
  // first deploy refused on the happy path.
  it("waits for provisioning to finish rather than refusing the first empty read", async () => {
    vi.useFakeTimers();
    let reads = 0;
    onSubcommand({
      status: () => status({ name: "harbor-warehousd", services: ["harbor-warehousd"] }),
      add: () => "added",
      variables: () =>
        ++reads > 2 ? JSON.stringify({ DATABASE_URL: "postgres://u:p@h:5432/railway" }) : "{}",
    });

    const pending = railway.provisionDatabase!(context(load()));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBe("postgres://u:p@h:5432/railway");
    expect(reads).toBe(3);
    // `add` is not idempotent — a retry that re-ran it would provision a second database.
    expect(calls().filter((c) => c === "add --database postgres")).toHaveLength(1);
  });

  // A deploy that proceeded with no database would fail at boot with nothing pointing at why.
  it("refuses when the database service reports no URL at all", async () => {
    vi.useFakeTimers();
    onSubcommand({
      status: () => status({ name: "harbor-warehousd", services: ["Postgres"] }),
      variables: () => JSON.stringify({ PGDATA: "/var/lib/postgresql/data" }),
    });

    const pending = railway.provisionDatabase!(context(load()));
    const settled = expect(pending).rejects.toThrow(/DATABASE_URL/);
    await vi.advanceTimersByTimeAsync(35_000);
    await settled;
  });
});

describe("setSecrets", () => {
  it("sends every line in one invocation", async () => {
    onSubcommand({ variables: () => "" });

    await railway.setSecrets(context(load()), [
      "BETTER_AUTH_SECRET=s3cret",
      "WAREHOUSD_ADMIN_PASSWORD=pw",
    ]);

    // Railway triggers a redeploy per `variables` call; one call per line would queue a dozen of
    // them ahead of the deploy that matters.
    expect(calls().filter((c) => c.startsWith("variables"))).toHaveLength(1);
    expect(calls()[0]).toContain("--set BETTER_AUTH_SECRET=s3cret");
    expect(calls()[0]).toContain("--set WAREHOUSD_ADMIN_PASSWORD=pw");
  });

  it("carries the environment Fly gets from fly.toml's [env]", async () => {
    onSubcommand({ variables: () => "" });

    await railway.setSecrets(context(load()), ["BETTER_AUTH_SECRET=s3cret"]);

    const argv = calls()[0]!;
    expect(argv).toContain("--set PORT=8722");
    expect(argv).toContain("--set WAREHOUSD_PROJECT_DIR=/project");
    expect(argv).toContain("--set NODE_ENV=production");
  });

  // Its absence is what keeps demo personas from being seeded — the same reasoning that keeps it
  // out of fly.toml.
  it("never sets WAREHOUSD_DEMO", async () => {
    onSubcommand({ variables: () => "" });

    await railway.setSecrets(context(load()), ["BETTER_AUTH_SECRET=s3cret"]);

    expect(calls()[0]).not.toContain("WAREHOUSD_DEMO");
  });
});

describe("deploy", () => {
  it("uploads the bundle with a Dockerfile and a railway.json beside it", async () => {
    onSubcommand({ up: () => "" });
    const cfg = load();
    const ctx = context(cfg);

    await railway.deploy(ctx);

    expect(readFileSync(join(ctx.deployDir, "Dockerfile"), "utf8")).toContain(
      "FROM ghcr.io/example/warehousd:test",
    );
    expect(readFileSync(join(ctx.deployDir, "railway.json"), "utf8")).toContain("/api/health");
    // deployDir, not contextDir: `COPY context /project` resolves against the uploaded directory.
    expect(calls()).toContain(`up --detach --service harbor-warehousd ${ctx.deployDir}`);
  });

  // Railway builds remotely, always. There is no `--remote-only` to opt out of and no Docker
  // daemon on this machine to reach for.
  it("ignores --local-build rather than shelling out to Docker", async () => {
    onSubcommand({ up: () => "" });
    const ctx = { ...context(load()), localBuild: true };

    await railway.deploy(ctx);

    for (const call of vi.mocked(execFileSyncRef).mock.calls) {
      expect(call[0]).toBe("railway");
    }
  });
});

describe("renderRailwayJson", () => {
  // The deploy polls /api/health once itself and then stops looking. Without this, nothing
  // notices a container that wedges an hour later and it stays in rotation serving errors.
  it("points Railway at the health endpoint", () => {
    expect(JSON.parse(renderRailwayJson({ region: "us-west2" })).deploy.healthcheckPath).toBe(
      "/api/health",
    );
  });

  // Railway has no --region flag on any command, so this file is the only place deploy.region can
  // take effect. A region validated at pre-flight and then dropped would decide nothing.
  it("is where deploy.region takes effect", () => {
    const rendered = JSON.parse(renderRailwayJson({ region: "us-west2" }));
    expect(rendered.deploy.multiRegionConfig).toEqual({ "us-west2": { numReplicas: 1 } });
  });

  it("builds from the rendered Dockerfile", () => {
    const rendered = JSON.parse(renderRailwayJson({ region: "us-west2" }));
    expect(rendered.build).toEqual({ builder: "DOCKERFILE", dockerfilePath: "Dockerfile" });
  });
});

describe("appUrl", () => {
  // `runDeploy` calls appUrl *before* deploy, because BETTER_AUTH_URL has to be in the secrets the
  // release reads. So on a first deploy the service has no deployment and Railway has no port to
  // infer one from — without --port it declines to generate a domain at all, which used to be a
  // refusal on the happy path.
  it("names the service and the container port, so a first deploy can generate one", async () => {
    onSubcommand({ domain: () => JSON.stringify({ domain: "harbor.up.railway.app" }) });

    await railway.appUrl(context(load()));

    expect(calls()).toContain("domain --service harbor-warehousd --port 8722 --json");
  });

  it("prefers the --json body, which is the contract", async () => {
    onSubcommand({
      domain: () =>
        JSON.stringify({ domain: "https://harbor-warehousd-production.up.railway.app/" }),
    });

    expect(await railway.appUrl(context(load()))).toBe(
      "https://harbor-warehousd-production.up.railway.app",
    );
  });

  it("reads a domains array too, older CLI versions spelling it that way", async () => {
    onSubcommand({
      domain: () => JSON.stringify({ domains: [{ domain: "harbor.up.railway.app" }] }),
    });

    expect(await railway.appUrl(context(load()))).toBe("https://harbor.up.railway.app");
  });

  // The regex is the fallback, not the contract: the printed wording has changed across CLI
  // versions, and a version that does not serialise still has to work.
  it("falls back to the printed line when the body is not JSON", async () => {
    onSubcommand({
      domain: () =>
        "🚂 Your service is now available at harbor-warehousd-production.up.railway.app",
    });

    expect(await railway.appUrl(context(load()))).toBe(
      "https://harbor-warehousd-production.up.railway.app",
    );
  });

  it("falls back to RAILWAY_PUBLIC_DOMAIN when the printed line yields nothing", async () => {
    onSubcommand({
      domain: () => "Service already has a domain",
      variables: () =>
        JSON.stringify({ RAILWAY_PUBLIC_DOMAIN: "harbor-warehousd-production.up.railway.app" }),
    });

    expect(await railway.appUrl(context(load()))).toBe(
      "https://harbor-warehousd-production.up.railway.app",
    );
  });

  // A domain command that failed outright is not a deploy with no address: the service may already
  // have one, and the variable is where that is readable.
  it("still resolves when domain fails but the variable carries the host", async () => {
    onSubcommand({
      domain: () => {
        throw new Error("no domain");
      },
      variables: () =>
        JSON.stringify({ RAILWAY_PUBLIC_DOMAIN: "harbor-warehousd-production.up.railway.app" }),
    });

    expect(await railway.appUrl(context(load()))).toBe(
      "https://harbor-warehousd-production.up.railway.app",
    );
  });

  it("refuses rather than returning null, which would skip the health poll", () => {
    onSubcommand({
      domain: () => {
        throw new Error("no domain");
      },
      variables: () => JSON.stringify({}),
    });

    expect(() => railway.appUrl(context(load()))).toThrow(/public domain/);
  });
});

describe("destroy", () => {
  it("deletes the project, which is what took the managed database with it", async () => {
    onSubcommand({
      status: () =>
        status({ name: "harbor-warehousd", services: ["harbor-warehousd", "Postgres"] }),
      delete: () => "deleted",
    });

    await railway.destroy(context(load()));

    expect(calls()).toContain("delete --yes");
  });

  // `railway delete` acts on whatever is linked. An operator who linked an existing project by
  // hand may have other services in it, and the config never named it.
  it("refuses to delete a project the config does not name", () => {
    onSubcommand({
      status: () => status({ name: "someone-elses-project", services: [] }),
      delete: () => "deleted",
    });

    expect(() => railway.destroy(context(load()))).toThrow(/someone-elses-project/);
    expect(calls()).not.toContain("delete --yes");
  });

  // A deploy that failed between `init` and `add` has a project the CLI may refuse to delete.
  // Throwing there leaves the operator an error and nothing left to retry.
  it("says what is left over rather than throwing", async () => {
    onSubcommand({
      status: () => status({ name: "harbor-warehousd", services: [] }),
      delete: () => {
        throw new Error("exit 1");
      },
    });

    await railway.destroy(context(load()));

    expect(said.join("\n")).toContain("railway open");
  });
});
