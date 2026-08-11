import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// What every command actually prints, driven as a subprocess against the built bundle.
//
// The gap this fills. `packages/cli/src/program.ts` is excluded from coverage (vitest.coverage.ts)
// because every export in it is an argv-driven action callback: the frame each command opens, the
// `└` sentence it closes on, which stream each block goes to, and the exit code — none of it is
// reachable from a unit test, and all of it is what a user sees. `lifecycle.e2e.test.ts` covers the
// half that needs containers; **this suite deliberately needs none**, so it runs in seconds, on any
// machine, with no image to pull, and can be the gate on the whole command surface.
//
// Three renderings are asserted, because the CLI has three and they are not the same code path:
//
//   - `piped`  — no terminal. Flat two-space indent, ASCII marks, no frame, no escape byte. This is
//                the contract the rest of the world sees: CI logs, `| jq`, `> file`.
//   - `rail`   — a terminal, colour off. The frame and its glyphs, without ANSI in the way of an
//                assertion. `FORCE_COLOR` makes resolveTheme treat the pipe as a terminal;
//                `NO_COLOR` then removes the colour, which is exactly the split those two flags
//                are for.
//   - `colour` — a terminal with 24-bit colour, for the handful of assertions that are about
//                colour itself.
//
// Everything below runs against one scaffolded project created once, in a temp directory. Nothing
// here starts a container, touches a database, or reaches the network.

const CLI_DIST = new URL("../../dist/index.cjs", import.meta.url).pathname;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`);

type Run = { status: number | null; out: string; err: string; both: string };

/**
 * A base environment with the colour variables stripped.
 *
 * Whoever runs this suite may have `FORCE_COLOR` or `NO_COLOR` set — CI runners commonly do — and
 * inheriting either would make the piped assertions below pass or fail for a reason that has
 * nothing to do with the CLI.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  delete env.COLORTERM;
  delete env.TERM;
  return env;
}

let project: string;

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  const r = spawnSync("node", [CLI_DIST, ...args], {
    cwd: opts.cwd ?? project,
    env: { ...baseEnv(), ...opts.env },
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  return {
    status: r.status,
    out: r.stdout ?? "",
    err: r.stderr ?? "",
    both: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

/** No terminal: flat, ASCII, no escape byte anywhere. */
const piped = (args: string[], cwd?: string) => run(args, cwd === undefined ? {} : { cwd });

/** A terminal with the colour turned off — the frame, without ANSI in the way of an assertion. */
const rail = (args: string[], cwd?: string) =>
  run(args, { ...(cwd === undefined ? {} : { cwd }), env: { FORCE_COLOR: "1", NO_COLOR: "1" } });

/** A terminal with 24-bit colour, for the assertions that are about colour itself. */
const colour = (args: string[], cwd?: string) =>
  run(args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: { FORCE_COLOR: "3", COLORTERM: "truecolor" },
  });

/** The brand accent in 24-bit, which is what "something you can type" is drawn in. */
const ACCENT = "38;2;29;158;117";

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`CLI dist not found at ${CLI_DIST}. Run: pnpm --filter ./packages/cli build`);
  }
  project = mkdtempSync(join(tmpdir(), "wh-surface-"));
  // The scaffold, written by the command this suite also asserts on. If `init` is broken every
  // test below fails, which is the right blast radius: nothing else works without it.
  const r = piped(["init", "--no-input"]);
  if (r.status !== 0) throw new Error(`init failed (${r.status})\n${r.both}`);

  // A file that matches the scaffolded `announcements` collection, and one that matches nothing.
  writeFileSync(
    join(project, "announcements.csv"),
    [
      "id,title,summary,owner,updated_at",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301,First,A summary,ops,2026-01-01T00:00:00Z",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3302,Second,Another,ops,2026-01-02T00:00:00Z",
    ].join("\n"),
  );
  writeFileSync(
    join(project, "people.csv"),
    ["id,Full Name,base_salary", "1,Ann,100", "2,Bo,200"].join("\n"),
  );
});

afterAll(() => {
  if (project) rmSync(project, { recursive: true, force: true });
});

// ── The frame ───────────────────────────────────────────────────────────────────────────────────

describe("the frame", () => {
  /**
   * The complaint the redesign exists for: the output was a mix of styles, and nothing connected.
   *
   * Every command that says anything opens on `┌ warehousd <name>` and closes on a `└`. Asserted
   * across a spread of commands rather than one, because the wiring is per-action and a command
   * that forgot its frame would look fine in isolation.
   */
  it.each([
    ["status", ["status"]],
    ["doctor", ["doctor"]],
    ["migrate plan", ["migrate", "plan"]],
    ["secrets", ["secrets"]],
  ])("opens and closes around %s", (_name, args) => {
    const r = rail(args);
    expect(r.both).toContain("┌  warehousd ");
    expect(r.both).toContain("└  ");
  });

  // The `└` is a what-next sentence, never a repeat of the status above it — including on the two
  // commands below, which fail.
  it("closes on what to do next, not on what just happened", () => {
    expect(rail(["status"]).both).toContain("└  `warehousd start` brings the stack up.");
    expect(rail(["migrate", "plan"]).both).toContain("└  Run `warehousd start`");
    expect(rail(["secrets"]).both).toContain("└  Fix the problem above, then re-run");
  });

  // One blank line after the close, so the next shell prompt does not land against it.
  it("leaves a blank line between itself and the next prompt", () => {
    expect(rail(["status"]).out.endsWith("\n\n")).toBe(true);
  });

  /**
   * Off a terminal there is no frame at all — not an ASCII one.
   *
   * A `|` in front of every line is a `|` in everything anybody greps, and a rail drawn into a CI
   * log is decoration nobody asked for.
   */
  it("draws nothing at all where there is no terminal", () => {
    const r = piped(["status"]);
    for (const glyph of ["┌", "│", "└", "◇", "▲", "■"]) expect(r.both).not.toContain(glyph);
    expect(r.both).not.toMatch(ANSI);
  });
});

// ── The two streams ─────────────────────────────────────────────────────────────────────────────

describe("stdout and stderr", () => {
  // The contract everything else rests on: narration on stderr, the product on stdout.
  it("keeps a parseable payload on stdout under --json, and says nothing else there", () => {
    const r = piped(["status", "--json"]);
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(JSON.parse(r.out)).toHaveProperty("healthy", false);
    expect(r.out).not.toContain("release candidate");
  });

  it("draws no frame under --json, even on a terminal", () => {
    const r = colour(["status", "--json"]);
    expect(r.out.trimStart().startsWith("{")).toBe(true);
    expect(r.out).not.toMatch(ANSI);
    for (const glyph of ["┌", "│", "└"]) expect(r.out).not.toContain(glyph);
  });

  it("puts the release-candidate notice on stderr and nowhere else", () => {
    for (const args of [["--version"], ["status", "--json"], ["--help"]]) {
      const r = piped(args);
      expect(r.err).toContain("This is a release candidate");
      expect(r.out).not.toContain("release candidate");
    }
  });

  /**
   * One blank line above the notice **and** one below, in every case.
   *
   * It used to carry only the one above and rely on whatever followed bringing its own top
   * spacing, which a panel did and a bare result line did not.
   */
  it("clears the shell prompt above the notice and whatever follows below it", () => {
    const lines = piped(["--version"]).err.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toContain("This is a release candidate");
    expect(lines[2]).toContain("https://github.com/tregismoreira/warehousd");
    expect(lines[3]).toBe("");
  });

  // `import map`'s product is a YAML block people pipe into warehousd.yml, so everything the run
  // has to *say* about it goes to stderr instead. The two used to be one string.
  it("leaves the import map proposal alone on stdout", () => {
    const r = rail(["import", "map", "people.csv"]);
    expect(r.out).toContain("collections:");
    expect(r.out).toContain("base_salary");
    for (const glyph of ["┌", "│", "└"]) expect(r.out).not.toContain(glyph);
    expect(r.err).toContain("┌  warehousd import map people.csv");
    expect(r.err).toContain("Closed by default");
  });
});

// ── Colour and glyphs ───────────────────────────────────────────────────────────────────────────

describe("colour and glyphs", () => {
  it("marks a failure with the red ■ and a success with the accent ◇", () => {
    expect(rail(["status"]).both).toContain("■  No containers for this project.");
    expect(rail(["migrate", "plan"]).both).toContain("▲  No database and no previous deploy");
  });

  /**
   * Markdown punctuation is a workaround for not having colour, and this output has colour.
   *
   * A terminal that can print `warehousd start` in the type colour does not also need two grave
   * accents around it — but a pipe does, because there the backtick is the only thing marking the
   * span as something to type rather than something to read.
   */
  it("draws a command in the type colour instead of backticks, and keeps them without colour", () => {
    const c = colour(["status"]);
    expect(c.both).toContain(`${ACCENT}mwarehousd start`);
    expect(c.both).not.toContain("`warehousd start`");
    // Same terminal, colour off: the backtick is the only thing left marking the span.
    expect(rail(["status"]).both).toContain("`warehousd start`");
  });

  /**
   * Off a terminal the outro is not written at all, backticks or otherwise.
   *
   * The `└` line only exists inside a frame, and there is no frame in a pipe — so a redirected run
   * carries the answer and none of the suggestion. That is the designed contract (a rail in a CI
   * log helps nobody), and it is pinned here because it is the one place the redesign gives
   * something up rather than adding to it.
   */
  it("writes no outro at all where there is no frame to close", () => {
    const r = piped(["status"]);
    expect(r.both).toContain("No containers for this project.");
    expect(r.both).not.toContain("brings the stack up");
  });

  it("honours --no-color while keeping the frame", () => {
    const r = run(["status", "--no-color"], { env: { FORCE_COLOR: "3", COLORTERM: "truecolor" } });
    expect(r.both).not.toMatch(ANSI);
    expect(r.both).toContain("┌  warehousd status");
  });

  // Icons are dropped off a terminal rather than faked: there is no ASCII for a filing cabinet
  // worth having, and the label already says "Database".
  it("drops the concept icons where there is no terminal", () => {
    expect(piped(["doctor"]).both).not.toContain("🩺");
    expect(rail(["doctor"]).both).toContain("🩺");
  });

  // Every frame opens on `warehousd <command>`, icon or no icon: a glyph in front of one of them
  // breaks the one column the eye is scanning for.
  it("opens every frame on the same column, even the one that carries an icon", () => {
    expect(rail(["doctor"]).both).toContain("┌  warehousd doctor 🩺");
  });
});

// ── --quiet ─────────────────────────────────────────────────────────────────────────────────────

describe("--quiet", () => {
  /**
   * "Only errors and results." The blocks are the result; a greeting line and a suggestion about
   * what to run next are neither.
   */
  it("keeps the result and drops the two corners", () => {
    const r = rail(["status", "--quiet"]);
    expect(r.both).toContain("No containers for this project.");
    expect(r.both).not.toContain("┌");
    expect(r.both).not.toContain("└");
  });

  // A caller that asked for a payload and got silence would have no way to tell success from
  // failure except the exit code, which is the thing --json exists to improve on.
  it("never suppresses --json", () => {
    expect(() => JSON.parse(piped(["status", "--json", "--quiet"]).out)).not.toThrow();
  });
});

// ── Help ────────────────────────────────────────────────────────────────────────────────────────

describe("help", () => {
  // Commander's default is alphabetical, which puts `apply` — a command nobody runs on their first
  // day — above `init`. clig.dev: common things first.
  it("answers a bare warehousd with the grouped screen, and exits cleanly", () => {
    const r = piped([]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Start here");
    expect(r.out.indexOf("init")).toBeLessThan(r.out.indexOf("apply"));
    expect(r.out).toContain("Examples");
    expect(r.out).toContain("warehousd import run products data.csv");
  });

  it("gives --help the same screen", () => {
    expect(piped(["--help"]).out).toContain("Start here");
  });

  /**
   * The global flags are deliberately off the discovery screen and on every per-command one.
   *
   * `configureHelp` is inherited by every subcommand, so an unconditional override made
   * `warehousd start --help` print the list of commands instead of start's own flags — while the
   * screen's own last line promised the opposite.
   */
  it("gives each command its own flags, plus the global ones", () => {
    for (const args of [
      ["start", "--help"],
      ["migrate", "plan", "--help"],
    ]) {
      const r = piped(args);
      expect(r.out).not.toContain("Start here");
      expect(r.out).toContain("Global options:");
      expect(r.out).toContain("--json");
      expect(r.out).toContain("--verbose");
    }
    expect(piped(["start", "--help"]).out).toContain("--show-secrets");
    for (const flag of ["--json", "--quiet", "--verbose"]) {
      expect(piped([]).out).not.toContain(flag);
    }
  });

  it("refuses an unknown command with a suggestion rather than silence", () => {
    const r = piped(["statuss"]);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("statuss");
    expect(r.err).toContain("status");
  });

  it("prints a bare version number on stdout", () => {
    const r = piped(["--version"]);
    expect(r.status).toBe(0);
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ── init ────────────────────────────────────────────────────────────────────────────────────────

describe("init", () => {
  it("scaffolds the two files and says which", () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-init-"));
    try {
      const r = rail(["init", "--no-input"], dir);
      expect(r.status).toBe(0);
      expect(existsSync(join(dir, "warehousd.yml"))).toBe(true);
      expect(existsSync(join(dir, ".gitignore"))).toBe(true);
      expect(readFileSync(join(dir, "warehousd.yml"), "utf8")).toContain("collections:");
      expect(r.both).toContain("Project ready");
      expect(r.both).toContain("Files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Complaint 3: it used to end on a dim `Next: warehousd start` that read like narration.
   *
   * It ends on a Next-steps block and a full-contrast outro naming the command and what it does.
   */
  it("ends on what to do next, at full contrast", () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-init-"));
    try {
      const r = rail(["init", "--no-input"], dir);
      expect(r.both).toContain("Next steps");
      expect(r.both).toContain("warehousd start");
      expect(r.both).toContain("start the server and database on this machine");
      expect(r.both).toContain("Docs");
      expect(r.both).toContain("https://github.com/tregismoreira/warehousd");
      expect(r.both).toContain("└  Run `warehousd start` to bring your project up.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a payload rather than a panel under --json", () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-init-"));
    try {
      const r = piped(["init", "--no-input", "--json"], dir);
      const payload = JSON.parse(r.out);
      expect(payload.created).toContain("warehousd.yml");
      expect(r.out).not.toContain("Next steps");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Nothing is written before the questions are answered, and re-running does not clobber.
  it("keeps an existing config rather than overwriting it", () => {
    const r = rail(["init", "--no-input"]);
    expect(r.status).toBe(0);
    expect(r.both).toContain("already exists");
  });
});

// ── Commands that need no containers ────────────────────────────────────────────────────────────

describe("status", () => {
  it("says nothing is running, and exits non-zero", () => {
    const r = rail(["status"]);
    expect(r.status).toBe(1);
    expect(r.both).toContain("No containers for this project.");
  });

  it("reports the same thing as a payload", () => {
    const r = piped(["status", "--json"]);
    const payload = JSON.parse(r.out);
    expect(payload.healthy).toBe(false);
    expect(payload.containers).toEqual([]);
  });
});

describe("doctor", () => {
  it("frames its checklist and closes on what to do about it", () => {
    const r = rail(["doctor"]);
    expect([0, 1]).toContain(r.status);
    expect(r.both).toContain("┌  warehousd doctor 🩺");
    expect(r.both).toMatch(/config\s+warehousd\.yml/);
    expect(r.both).toMatch(/└ {2}(Everything checks out|\d+ problems? found)/);
  });

  it("reports the same checks as a payload", () => {
    const payload = JSON.parse(piped(["doctor", "--json"]).out);
    expect(typeof payload.ok).toBe("boolean");
    expect(payload.checks.map((c: { id: string }) => c.id)).toContain("config");
  });
});

describe("migrate plan", () => {
  // A plan before the first deploy has nothing to compare against, which is a caution rather than
  // a failure — and the outro says how to get one.
  it("says it has nothing to compare against, and how to fix that", () => {
    const r = rail(["migrate", "plan"]);
    expect(r.status).toBe(0);
    expect(r.both).toContain("▲  No database and no previous deploy");
    expect(r.both).toContain("└  Run `warehousd start`");
  });
});

describe("secrets", () => {
  // The one command whose entire output is credentials, run before anything generated any.
  it("refuses in our own words rather than pointing at the issue tracker", () => {
    const r = rail(["secrets"]);
    expect(r.status).toBe(1);
    expect(r.both).toContain("■  No secrets yet");
    expect(r.both).not.toContain("Unexpected error");
    expect(r.both).not.toContain("/issues");
    expect(r.both).toContain("└  Fix the problem above, then re-run `warehousd secrets`.");
  });
});

describe("import map", () => {
  it("proposes a collections block for a file that matches nothing", () => {
    const r = rail(["import", "map", "people.csv"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("collections:");
    expect(r.out).toContain("people:");
    expect(r.err).toContain("proposing a collections block");
  });

  /**
   * Deny-by-default is a guess about a column NAME, never a reading of the data.
   *
   * Saying so is the difference between a safe scaffold and one somebody trusts.
   */
  it("closes what looks sensitive, and says the guess is a guess", () => {
    const r = rail(["import", "map", "people.csv"]);
    expect(r.out).toContain("base_salary: { type: int, posture: deny");
    expect(r.err).toContain("Closed by default");
    expect(r.err).toContain("not a reading of the data");
  });

  it("proposes a column mapping where the collection already exists", () => {
    const r = rail(["import", "map", "announcements.csv"]);
    expect(r.err).toMatch(/no mapping needed|need mapping/);
  });
});

describe("import validate", () => {
  it("passes a file that matches, and says which layer ran", () => {
    const r = rail(["import", "validate", "announcements", "announcements.csv"]);
    expect(r.status).toBe(0);
    expect(r.both).toContain("◇  Validated 2 rows against announcements — offline");
    expect(r.both).toContain("checked: static (no database)");
    expect(r.both).toContain("└  `warehousd import run announcements announcements.csv` loads it.");
  });

  /**
   * The static layer has a false-failure mode, so it must always say what it could not see.
   *
   * A reader who took `unvalidatable_term` for a plain failure would go and chase a non-problem.
   */
  it("names what the offline layer is blind to", () => {
    expect(rail(["import", "validate", "announcements", "announcements.csv"]).both).toContain(
      "not checked:",
    );
  });

  it("refuses a file that does not match, and exits non-zero", () => {
    const r = rail(["import", "validate", "announcements", "people.csv"]);
    expect(r.status).toBe(1);
    expect(r.both).toContain("■  announcements refused the file");
    expect(r.both).toContain("└  Fix the rows above, then re-run.");
  });
});

describe("commands that need a running stack", () => {
  // Each of these could launch a browser at a dead port, or read a container that is not there.
  // Refusing by name beats doing nothing, and the outro says what to run.
  it.each([
    ["open", ["open"], "Nothing to open"],
    ["logs", ["logs"], "No container"],
  ])("%s refuses by name when nothing is running", (_name, args, expected) => {
    const r = rail(args);
    expect(r.status).toBe(1);
    expect(r.both).toContain(expected);
    expect(r.both).toContain("└  ");
  });

  // A stream has no last element, so there is no object to close.
  it("refuses --json with --follow rather than emitting unparseable text", () => {
    const r = piped(["logs", "--json", "--follow"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("a stream has no end to serialise");
  });
});

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

describe("failures", () => {
  /**
   * "No rule matched" is not the same as "unexpected".
   *
   * Most unmatched errors are warehousd's own finished sentences, and telling the reader to open an
   * issue about one of those is both wrong and rude.
   */
  it("frames a refusal and never ends on a bare stack of red", () => {
    const r = rail(["apply"], mkdtempSync(join(tmpdir(), "wh-nope-")));
    expect(r.status).toBe(1);
    expect(r.err).toContain("■  ");
    expect(r.err.trimEnd().split("\n").pop()).toContain("└  ");
  });

  it("keeps stdout empty on a failure, so a pipe reads nothing rather than half a result", () => {
    expect(piped(["secrets"]).out).toBe("");
    expect(piped(["apply"], mkdtempSync(join(tmpdir(), "wh-nope-"))).out).toBe("");
  });
});

// ── The promise that outranks every one above ───────────────────────────────────────────────────

describe("nothing prints a secret it was not asked for", () => {
  /**
   * "Denied means absent" applies to output too (AGENTS.md).
   *
   * This project has no state yet, so the strongest thing assertable here is that no command
   * invents one — but the shape of the check is the point: every human-facing surface, swept for
   * the words that would carry a credential.
   */
  it("says nothing that looks like a credential across the whole surface", () => {
    for (const args of [
      ["status"],
      ["doctor"],
      ["migrate", "plan"],
      ["import", "map", "people.csv"],
    ]) {
      const r = rail(args);
      expect(r.both).not.toMatch(/password\s*[:=]\s*\S/i);
      expect(r.both).not.toMatch(/client_secret/i);
    }
  });
});
