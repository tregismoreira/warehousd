import { describe, it, expect } from "vitest";
import {
  renderStartSummary,
  renderChecks,
  renderStatus,
  renderFields,
  renderSuccess,
  initNextSteps,
  docsOutro,
} from "../src/ui/render";
import { plainTheme, resolveTheme } from "../src/ui/theme";

// A CSI sequence: ESC [ ... final byte. Built from a code point so no raw control character ends
// up in this file.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);

// Two renderings, and both are asserted here. `plainTheme` is what a pipe gets — flat, indented,
// no rail, no icons. `railTheme` is what a terminal gets, with colour off so the strings stay
// readable in an assertion.
const railTheme = resolveTheme({ isTTY: true, env: { NO_COLOR: "1" } });

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

  /**
   * The moment the whole command exists for, and complaint 4 in the redesign.
   *
   * It used to end on the panel and nothing else, so somebody watching their first stack come up
   * was given six URLs and no second command.
   */
  it("says the data layer is up, then what to do with it", () => {
    const s = renderStartSummary({ outputs, admin, theme: plainTheme });
    expect(s).toContain("Your data layer is running");
    expect(s).toContain("Next steps");
    expect(s).toContain("warehousd open");
    expect(s).toContain("warehousd import run");
    expect(s).toContain("Everyday commands");
    expect(s).toContain("warehousd logs -f");
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

  it("shows them in full on request, and drops the masking hint", () => {
    const s = renderStartSummary({ outputs, admin, theme: plainTheme, showSecrets: true });
    expect(s).toContain(ADMIN_PASSWORD);
    expect(s).toContain(CLIENT_SECRET);
    expect(s).toContain(DB_PASSWORD);
    expect(s).not.toContain("warehousd secrets --show");
  });

  // The release-candidate line moved to the top of every invocation (src/ui/rc-notice.ts). Pinned
  // here so it does not drift back into the panel, where it would be said twice in one run.
  it("leaves the release-candidate line to the notice that opens every command", () => {
    for (const showSecrets of [false, true]) {
      const s = renderStartSummary({ outputs, admin, theme: plainTheme, showSecrets });
      expect(s).not.toContain("release candidate");
      expect(s).not.toContain("Release candidate");
    }
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

  // Every line hangs from the rail on a terminal, and every line is flat off one. Mixing the two
  // is what the old output did, and what this redesign is for.
  it("hangs every line from the rail on a terminal", () => {
    const lines = renderStartSummary({ outputs, admin, theme: railTheme }).split("\n");
    expect(lines[0]).toContain(`${railTheme.s.done}  `);
    for (const line of lines.slice(1)) expect(line.startsWith(railTheme.s.bar)).toBe(true);
  });

  it("draws no rail and no icon off a terminal", () => {
    const s = renderStartSummary({ outputs, admin, theme: plainTheme });
    expect(s).not.toContain("│");
    expect(s).not.toContain("🚀");
  });

  it("carries the concept icons on a terminal", () => {
    const s = renderStartSummary({ outputs, admin, theme: railTheme });
    expect(s).toContain("🚀");
    expect(s).toContain("🔑");
    expect(s).toContain("👤");
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

// One shape for every command that finishes. Commands used to end however their author felt on the
// day, so nothing looked like completion — `init` in particular left people unsure it had run.
describe("renderSuccess", () => {
  it("marks the headline with the done glyph, so completion is visible at a glance", () => {
    const s = renderSuccess({ headline: "Configuration applied", theme: railTheme });
    expect(s).toBe(`${railTheme.s.done}  Configuration applied`);
  });

  it("needs no sections — a command with nothing to report is still a headline", () => {
    const s = renderSuccess({ headline: "Containers stopped", theme: plainTheme });
    expect(s).toContain("Containers stopped");
    expect(s.trim().split("\n")).toHaveLength(1);
  });

  it("lays fields out like every other panel", () => {
    const s = renderSuccess({
      headline: "Loaded into products",
      theme: plainTheme,
      sections: [
        {
          fields: [
            { label: "Added", value: "12" },
            { label: "Deleted", value: "3" },
          ],
        },
      ],
    });
    // Labels pad to the widest in their section, so the values start on one column.
    const values = s
      .split("\n")
      .filter((l) => /Added|Deleted/.test(l))
      .map((l) => l.search(/\d/));
    expect(values).toHaveLength(2);
    expect(new Set(values).size).toBe(1);
  });

  it("indents every footer line, not only the first", () => {
    const s = renderSuccess({
      headline: "Containers stopped",
      theme: railTheme,
      footer: ["first", "second"],
    });
    for (const line of ["│  first", "│  second"]) expect(s).toContain(line);
  });

  it("masks a secret field unless told otherwise", () => {
    const fields = [{ label: "Password", value: ADMIN_PASSWORD, secret: true }];
    const masked = renderSuccess({ headline: "Done", theme: plainTheme, sections: [{ fields }] });
    expect(masked).not.toContain(ADMIN_PASSWORD);
    const shown = renderSuccess({
      headline: "Done",
      theme: plainTheme,
      sections: [{ fields }],
      showSecrets: true,
    });
    expect(shown).toContain(ADMIN_PASSWORD);
  });

  // Blank lines belong to the caller, which is what owns the frame — the same contract
  // ui/brand.ts, ui/rc-notice.ts and ui/errors.ts already keep.
  it("brings no blank line of its own at either end", () => {
    const s = renderSuccess({
      headline: "Done",
      theme: railTheme,
      sections: [{ fields: [{ label: "a", value: "1" }] }],
    });
    expect(s.startsWith("\n")).toBe(false);
    expect(s.endsWith("\n")).toBe(false);
  });

  it("carries no ANSI when there is no terminal behind it", () => {
    expect(renderSuccess({ headline: "Done", theme: plainTheme })).not.toMatch(ANSI);
  });

  // The glyph is the brand accent, not the generic green the reporter used to use for a step.
  it("colours the glyph with the brand accent on a capable terminal", () => {
    const theme = resolveTheme({ isTTY: true, env: { COLORTERM: "truecolor" } });
    expect(renderSuccess({ headline: "Done", theme })).toContain("38;2;29;158;117");
  });
});

describe("renderFields", () => {
  it("aligns values within a section", () => {
    const s = renderFields({
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
    const s = renderFields({
      theme: plainTheme,
      sections: [{ title: "Nothing", fields: [] }],
    });
    expect(s).not.toContain("Nothing");
  });

  it("masks by default and reveals on request", () => {
    const sections = [{ fields: [{ label: "Password", value: ADMIN_PASSWORD, secret: true }] }];
    expect(renderFields({ theme: plainTheme, sections })).not.toContain(ADMIN_PASSWORD);
    expect(renderFields({ theme: plainTheme, sections, showSecrets: true })).toContain(
      ADMIN_PASSWORD,
    );
  });
});

describe("renderChecks", () => {
  const checks = [
    { id: "docker", ok: true, detail: "daemon reachable, server 29.6.2" },
    { id: "port:server", ok: false, detail: "8722 is held by container other_server" },
  ];

  it("marks each check and keeps its detail", () => {
    const s = renderChecks(checks, plainTheme);
    expect(s).toContain("o ");
    expect(s).toContain("x ");
    expect(s).toContain("8722 is held by container other_server");
  });

  it("puts the mark in the rail column on a terminal", () => {
    const lines = renderChecks(checks, railTheme).split("\n");
    expect(lines[0]!.startsWith(`${railTheme.s.done}  `)).toBe(true);
    expect(lines[1]!.startsWith(`${railTheme.s.fail}  `)).toBe(true);
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
    expect(s).toContain("harbor is running");
    expect(s).toContain("wh_harbor_server");
    expect(s).toContain("Up 2 minutes");
    expect(s).not.toContain(DB_PASSWORD);
  });

  it("says so when the stack is not answering, under the failure glyph", () => {
    const s = renderStatus({
      project: "harbor",
      healthy: false,
      containers: [{ name: "wh_harbor_server", state: "Exited (1)" }],
      outputs: null,
      theme: railTheme,
    });
    expect(s).toContain("harbor is not responding");
    expect(s.startsWith(`${railTheme.s.fail}  `)).toBe(true);
  });
});

describe("the onboarding blocks", () => {
  it("init suggests the two commands that follow it", () => {
    const lines = initNextSteps(plainTheme);
    expect(lines[0]).toBe("Next steps");
    expect(lines.join("\n")).toContain("warehousd start");
    expect(lines.join("\n")).toContain("warehousd open");
  });

  it("the docs outro names one URL", () => {
    expect(docsOutro(plainTheme)).toBe(
      "Docs and guides: https://github.com/tregismoreira/warehousd",
    );
  });
});
