import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  text: vi.fn(() => Promise.resolve("answer")),
  select: vi.fn(() => Promise.resolve("managed")),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
}));

import * as clack from "@clack/prompts";
import { promptInit } from "../src/ui/prompt";
import { collectSecrets } from "../src/commands/secrets";
import { renderDeploySummary, renderStatus, renderChecks } from "../src/ui/render";
import { applyAnswers } from "../src/init";
import { plainTheme } from "../src/ui/theme";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-br-"));
  mkdirSync(join(dir, ".warehousd"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const OUTPUTS = {
  mcpUrl: "http://localhost:8722/mcp",
  apiUrl: "http://localhost:8722",
  adminUrl: "http://localhost:8722/admin",
  databaseUrl: "postgres://warehousd:pw0123456789@localhost:8723/warehousd",
  env: "dev",
  devClient: { clientId: "cid", clientSecret: "csecret0123456789" },
};

const STATE = {
  dbPassword: "dbpassword0123456",
  dataRolePassword: "drp",
  betterAuthSecret: "bas",
  adminPassword: "adminpassword0123",
  devClientSecret: "csecret0123456789",
};

// `start` writes both files, but `stop --destroy` removes outputs.json and keeps state.json, so
// each can legitimately exist without the other.
describe("collectSecrets with only one file present", () => {
  it("works from state.json alone", () => {
    writeFileSync(join(dir, ".warehousd", "state.json"), JSON.stringify(STATE));
    const labels = collectSecrets(dir).map((e) => e.label);
    expect(labels).toContain("Admin password");
    expect(labels).not.toContain("Dev client ID");
  });

  it("works from outputs.json alone", () => {
    writeFileSync(join(dir, ".warehousd", "outputs.json"), JSON.stringify(OUTPUTS));
    const labels = collectSecrets(dir).map((e) => e.label);
    expect(labels).toContain("Dev client secret");
    expect(labels).not.toContain("Admin password");
  });
});

describe("promptInit validation", () => {
  /** Pull the `validate` callback clack was handed, so its branches can be exercised directly. */
  async function validatorFor(callIndex: number) {
    await promptInit({ project: "my-app", port: 8722, managed: true });
    const call = vi.mocked(clack.text).mock.calls[callIndex]?.[0] as {
      validate?: (v: string) => string | undefined;
    };
    return call.validate!;
  }

  it("accepts an ordinary project name and rejects punctuation", async () => {
    const validate = await validatorFor(0);
    expect(validate("acme data")).toBeUndefined();
    expect(validate("acme/data")).toContain("Letters");
  });

  it("accepts an empty project name, since a default is offered", async () => {
    const validate = await validatorFor(0);
    expect(validate("")).toBeUndefined();
  });

  it("accepts a port in range and rejects one outside it", async () => {
    const validate = await validatorFor(1);
    expect(validate("8722")).toBeUndefined();
    expect(validate("")).toBeUndefined();
    expect(validate("70000")).toContain("port");
    expect(validate("0")).toContain("port");
    expect(validate("abc")).toContain("port");
  });

  it("falls back to the defaults when the answers come back empty", async () => {
    vi.mocked(clack.text).mockResolvedValueOnce("").mockResolvedValueOnce("");
    const answers = await promptInit({ project: "fallback", port: 9999, managed: true });
    expect(answers).toEqual({ project: "fallback", port: 9999, managed: true });
  });
});

describe("applyAnswers", () => {
  const TEMPLATE = [
    "project: my-app",
    "server:",
    "  port: 8722",
    "# database:",
    "#   managed: true                 # default — the CLI runs Postgres in Docker",
    "#   url: ${env:DATABASE_URL}      # alternative: bring your own Postgres",
    "",
    "collections: {}",
  ].join("\n");

  it("substitutes the project name and port", () => {
    const out = applyAnswers(TEMPLATE, { project: "acme", port: 9001, managed: true });
    expect(out).toContain("project: acme");
    expect(out).toContain("  port: 9001");
    // Managed is the template's default, so the database block stays commented.
    expect(out).toContain("# database:");
  });

  it("uncomments the database block when the user brings their own Postgres", () => {
    const out = applyAnswers(TEMPLATE, { project: "acme", port: 9001, managed: false });
    expect(out).toContain("database:\n  url: ${env:DATABASE_URL}");
    expect(out).not.toContain("# database:");
  });

  it("keeps the rest of the template intact", () => {
    const out = applyAnswers(TEMPLATE, { project: "acme", port: 9001, managed: true });
    expect(out).toContain("collections: {}");
  });
});

// `deploy` used to hand-roll its failed pre-flight as `  ✗ ${id}: ${detail}` with the glyph
// hardcoded, so it ignored NO_COLOR and could not fall back to ASCII. It goes through the shared
// renderer now; these assert the two properties that hardcoding lost.
describe("renderChecks under a plain theme", () => {
  const failed = [
    { id: "sso-or-local-login", ok: false, detail: "no SSO configured" },
    { id: "env-refs-resolve", ok: false, detail: "SSO_CLIENT_ID is not set" },
  ];

  it("uses ASCII glyphs and no escape codes", () => {
    const s = renderChecks(failed, plainTheme);
    expect(s).not.toContain("✗");
    expect(s).toContain("x");
    expect(s).not.toContain(String.fromCharCode(27));
  });

  it("keeps every id and detail", () => {
    const s = renderChecks(failed, plainTheme);
    for (const c of failed) {
      expect(s).toContain(c.id);
      expect(s).toContain(c.detail);
    }
  });

  it("aligns the details past the longest id", () => {
    const lines = renderChecks(failed, plainTheme).split("\n");
    expect(lines[0]!.indexOf("no SSO configured")).toBe(
      lines[1]!.indexOf("SSO_CLIENT_ID is not set"),
    );
  });
});

describe("render branches", () => {
  it("renders a deploy with a Fly-managed database and no admin block", () => {
    const s = renderDeploySummary({
      outputs: {
        mcpUrl: "https://a.fly.dev/mcp",
        apiUrl: "https://a.fly.dev",
        adminUrl: "https://a.fly.dev/admin",
        databaseUrl: null,
        env: "dev",
      },
      target: { label: "Fly.io", databaseHint: "managed by Fly Postgres — `fly postgres connect`" },
      theme: plainTheme,
    });
    expect(s).toContain("fly postgres connect");
    expect(s).not.toContain("Admin login");
  });

  // The hint and the heading are the target's words, not this module's. Both used to name Fly
  // unconditionally, which is the whole reason they are arguments now.
  it("names the target it was given, and no other", () => {
    const s = renderDeploySummary({
      outputs: {
        mcpUrl: "http://localhost:8722/mcp",
        apiUrl: "http://localhost:8722",
        adminUrl: "http://localhost:8722/admin",
        databaseUrl: null,
        env: "dev",
      },
      target: {
        label: "Docker Compose",
        databaseHint: "the `db` service",
        notes: ["Nothing is running yet", "TLS is yours to terminate"],
      },
      theme: plainTheme,
    });
    expect(s).toContain("warehousd deployed to Docker Compose");
    expect(s).toContain("the `db` service");
    expect(s).not.toMatch(/fly/i);
  });

  // A footer of several lines used to indent only its first, so the notes would have stepped out
  // to column zero under the panel they belong to.
  it("indents every footer line alike", () => {
    const s = renderDeploySummary({
      outputs: {
        mcpUrl: "http://localhost:8722/mcp",
        apiUrl: "http://localhost:8722",
        adminUrl: "http://localhost:8722/admin",
        databaseUrl: null,
        env: "dev",
      },
      target: { label: "Docker Compose", databaseHint: "the `db` service", notes: ["first"] },
      theme: plainTheme,
    });
    const first = s.split("\n").find((l) => l.includes("first"));
    const masked = s.split("\n").find((l) => l.includes("Secrets are masked"));
    expect(first?.indexOf("first")).toBe(masked?.indexOf("Secrets"));
  });

  it("shows a deploy database URL in full on request", () => {
    const url = "postgres://u:supersecretvalue@prod.example.com/db";
    const s = renderDeploySummary({
      outputs: {
        mcpUrl: "https://a.fly.dev/mcp",
        apiUrl: "https://a.fly.dev",
        adminUrl: "https://a.fly.dev/admin",
        databaseUrl: url,
        env: "dev",
      },
      target: { label: "Fly.io", databaseHint: "managed by Fly Postgres" },
      theme: plainTheme,
      showSecrets: true,
    });
    expect(s).toContain(url);
  });

  it("shows the status database URL in full on request", () => {
    const s = renderStatus({
      project: "harbor",
      healthy: true,
      containers: [{ name: "wh_harbor_server", state: "Up" }],
      outputs: OUTPUTS,
      theme: plainTheme,
      showSecrets: true,
    });
    expect(s).toContain(OUTPUTS.databaseUrl);
  });

  it("renders a healthy stack that has no outputs file", () => {
    const s = renderStatus({
      project: "harbor",
      healthy: true,
      containers: [{ name: "wh_harbor_server", state: "Up" }],
      outputs: null,
      theme: plainTheme,
    });
    expect(s).toContain("running");
    expect(s).not.toContain("MCP");
  });
});
