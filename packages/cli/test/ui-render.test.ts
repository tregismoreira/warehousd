import { describe, it, expect } from "vitest";
import { renderStartSummary, renderChecks, renderStatus, renderPanel } from "../src/ui/render";
import { plainTheme, resolveTheme } from "../src/ui/theme";

// A CSI sequence: ESC [ ... final byte. Built from a code point so no raw control character ends
// up in this file.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);

const ADMIN_PASSWORD = "7ac704bfe39537f7a0898b2afd9d38715be7725bdf12996b";
const CLIENT_SECRET = "4215ee19af34169dc1cf6d2ffd3250a8e3748f4a2edc5a76feb62bd0908bdaf8";
const DB_PASSWORD = "7fc2e6dd2bde6a62a20668866334458a8e95e4bee341c97d";

const outputs = {
  mcpUrl: "http://localhost:8722/mcp",
  apiUrl: "http://localhost:8722",
  adminUrl: "http://localhost:8722/admin",
  databaseUrl: `postgres://warehousd:${DB_PASSWORD}@localhost:8723/warehousd`,
  env: "dev",
  devClient: { clientId: "2f564a968b9bbaafdb7b78cddec53c63", clientSecret: CLIENT_SECRET },
};

const admin = { email: "admin@warehousd.local", password: ADMIN_PASSWORD };

describe("renderStartSummary", () => {
  it("shows every URL a user came for", () => {
    const s = renderStartSummary({ outputs, admin, theme: plainTheme });
    expect(s).toContain("http://localhost:8722/mcp");
    expect(s).toContain("http://localhost:8722/admin");
    expect(s).toContain("admin@warehousd.local");
    expect(s).toContain("2f564a968b9bbaafdb7b78cddec53c63");
  });

  // The reason this module exists. `start` runs on every developer's machine, many times a day,
  // and used to leave both of these in scrollback each time.
  it("leaks no secret in the default rendering", () => {
    const s = renderStartSummary({ outputs, admin, theme: plainTheme });
    expect(s).not.toContain(ADMIN_PASSWORD);
    expect(s).not.toContain(CLIENT_SECRET);
    expect(s).not.toContain(DB_PASSWORD);
  });

  it("says how to get them back", () => {
    const s = renderStartSummary({ outputs, admin, theme: plainTheme });
    expect(s).toContain("warehousd secrets --show");
  });

  it("shows them in full on request, and drops the footer", () => {
    const s = renderStartSummary({ outputs, admin, theme: plainTheme, showSecrets: true });
    expect(s).toContain(ADMIN_PASSWORD);
    expect(s).toContain(CLIENT_SECRET);
    expect(s).toContain(DB_PASSWORD);
    expect(s).not.toContain("warehousd secrets --show");
  });

  it("omits the admin block when there is no admin to show", () => {
    const s = renderStartSummary({ outputs, theme: plainTheme });
    expect(s).not.toContain("Admin login");
    expect(s).toContain("Dev client");
  });

  it("carries an elapsed time when given one", () => {
    const s = renderStartSummary({ outputs, admin, theme: plainTheme, elapsed: "ready in 15.1s" });
    expect(s).toContain("ready in 15.1s");
  });

  it("emits no ANSI when colour is off", () => {
    const s = renderStartSummary({ outputs, admin, theme: plainTheme });
    expect(s).not.toMatch(ANSI);
  });

  it("emits ANSI when colour is on", () => {
    const theme = resolveTheme({ isTTY: true, env: {} });
    const s = renderStartSummary({ outputs, admin, theme });
    expect(s).toMatch(ANSI);
  });
});

describe("renderPanel", () => {
  it("aligns values within a section", () => {
    const s = renderPanel({
      title: "t",
      theme: plainTheme,
      sections: [
        {
          fields: [
            { label: "a", value: "1" },
            { label: "longer", value: "2" },
          ],
        },
      ],
    });
    const lines = s.split("\n").filter((l) => l.includes("1") || l.includes("2"));
    expect(lines[0]!.indexOf("1")).toBe(lines[1]!.indexOf("2"));
  });

  it("skips empty sections rather than printing a bare heading", () => {
    const s = renderPanel({
      title: "t",
      theme: plainTheme,
      sections: [{ title: "Nothing", fields: [] }],
    });
    expect(s).not.toContain("Nothing");
  });
});

describe("renderChecks", () => {
  const checks = [
    { id: "docker", ok: true, detail: "daemon reachable, server 29.6.2" },
    { id: "port:server", ok: false, detail: "8722 is held by container other_server" },
  ];

  it("marks each check and keeps its detail", () => {
    const s = renderChecks(checks, plainTheme);
    expect(s).toContain("ok");
    expect(s).toContain("x");
    expect(s).toContain("8722 is held by container other_server");
  });

  it("returns empty for no checks", () => {
    expect(renderChecks([], plainTheme)).toBe("");
  });
});

describe("renderStatus", () => {
  it("reports the project and its containers, masking the database password", () => {
    const s = renderStatus({
      project: "harbor",
      healthy: true,
      containers: [{ name: "wh_harbor_server", state: "Up 2 minutes" }],
      outputs,
      theme: plainTheme,
    });
    expect(s).toContain("harbor");
    expect(s).toContain("running");
    expect(s).toContain("wh_harbor_server");
    expect(s).toContain("Up 2 minutes");
    expect(s).not.toContain(DB_PASSWORD);
  });

  it("says so when the stack is not answering", () => {
    const s = renderStatus({
      project: "harbor",
      healthy: false,
      containers: [{ name: "wh_harbor_server", state: "Exited (1)" }],
      outputs: null,
      theme: plainTheme,
    });
    expect(s).toContain("not responding");
  });
});
