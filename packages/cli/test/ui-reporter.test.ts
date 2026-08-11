import { describe, it, expect } from "vitest";
import { createReporter, silentReporter, progressDetail, progressBar } from "../src/ui/reporter";
import { plainTheme, resolveTheme } from "../src/ui/theme";

// What a terminal gets, with colour off so the strings stay readable in an assertion.
const railTheme = resolveTheme({ isTTY: true, env: { NO_COLOR: "1" } });

// A fake clock, so elapsed times are asserted rather than tolerated.
function harness(opts: { isTTY?: boolean; quiet?: boolean } = {}) {
  const err: string[] = [];
  const out: string[] = [];
  let t = 0;
  const reporter = createReporter({
    writeErr: (s) => err.push(s),
    writeOut: (s) => out.push(s),
    theme: plainTheme,
    isTTY: opts.isTTY ?? false,
    quiet: opts.quiet ?? false,
    now: () => t,
  });
  return {
    reporter,
    err: () => err.join(""),
    out: () => out.join(""),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createReporter", () => {
  it("reports a completed step with its elapsed time", () => {
    const h = harness();
    const step = h.reporter.step("Pulling", "warehousd:dev");
    h.advance(1200);
    step.done();
    expect(h.err()).toContain("Pulling");
    expect(h.err()).toContain("warehousd:dev");
    expect(h.err()).toContain("1.2s");
  });

  it("uses milliseconds below a second", () => {
    const h = harness();
    const step = h.reporter.step("Checking", "harbor");
    h.advance(340);
    step.done();
    expect(h.err()).toContain("340ms");
  });

  it("carries the detail passed to done()", () => {
    const h = harness();
    h.reporter.step("Image", "warehousd:dev").done("server.image, local");
    expect(h.err()).toContain("server.image, local");
  });

  it("marks a failed step and does not claim success", () => {
    const h = harness();
    h.reporter.step("Waiting", "health check").fail();
    expect(h.err()).toContain(plainTheme.s.fail);
    expect(h.err()).not.toContain(plainTheme.s.done);
  });

  // The verb and the label are one sentence now. They used to sit either side of a ten-character
  // right-aligned gutter, which aligned but did not read.
  it("reads the verb and the label as one sentence, with no gutter", () => {
    const h = harness();
    h.reporter.step("Pulling", "warehousd:dev").done();
    expect(h.err()).toContain("Pulling warehousd:dev");
    expect(h.err()).not.toMatch(/ {4}Pulling/);
  });

  /**
   * A step that is still running says "Pulling"; the line that survives says "Pulled".
   *
   * The settled line is the one left on screen, and a page of present participles reads as a
   * command that never finished any of them.
   */
  it("settles into the past tense when given one", () => {
    const h = harness();
    h.reporter.step("Starting", "the server", "Server started").done(":8722");
    expect(h.err()).toContain("Server started — :8722");
    expect(h.err()).not.toContain("Starting the server");
  });

  it("puts the glyph in the rail column on a terminal", () => {
    const err: string[] = [];
    const reporter = createReporter({
      writeErr: (s) => err.push(s),
      writeOut: () => {},
      theme: railTheme,
      isTTY: false,
      now: () => 0,
    });
    reporter.step("Checking", "Docker", "Checked Docker").done("version 27.0.0");
    expect(err.join("")).toContain(`${railTheme.s.done}  Checked Docker — version 27.0.0`);
  });

  it("hangs a note, a warning and a failure from the rail", () => {
    const err: string[] = [];
    const reporter = createReporter({
      writeErr: (s) => err.push(s),
      writeOut: () => {},
      theme: railTheme,
      isTTY: false,
      now: () => 0,
    });
    reporter.note("a note");
    reporter.warn("a warning");
    reporter.fail("a failure");
    expect(err.join("")).toContain(`${railTheme.s.bar}  a note`);
    expect(err.join("")).toContain(`${railTheme.s.warn}  a warning`);
    expect(err.join("")).toContain(`${railTheme.s.fail}  a failure`);
  });

  it("settles only once, so a done() after a fail() cannot overwrite it", () => {
    const h = harness();
    const step = h.reporter.step("Waiting", "health check");
    step.fail();
    step.done();
    expect(h.err().split("Waiting")).toHaveLength(2);
  });

  // Narration and product go to different streams; this is what makes `start --json | jq` work.
  it("writes steps to stderr and out() to stdout", () => {
    const h = harness();
    h.reporter.step("Starting", "server").done();
    h.reporter.out("{}");
    expect(h.err()).toContain("Starting");
    expect(h.err()).not.toContain("{}");
    expect(h.out()).toBe("{}\n");
  });

  it("does not double a trailing newline on out()", () => {
    const h = harness();
    h.reporter.out("already\n");
    expect(h.out()).toBe("already\n");
  });

  it("quiet suppresses successful steps and notes", () => {
    const h = harness({ quiet: true });
    h.reporter.step("Starting", "server").done();
    h.reporter.note("Next: warehousd start");
    expect(h.err()).toBe("");
  });

  it("quiet still reports failures — silence about an error is the one thing it must not do", () => {
    const h = harness({ quiet: true });
    h.reporter.step("Waiting", "health check").fail();
    h.reporter.fail("Container health check failed");
    expect(h.err()).toContain("health check");
    expect(h.err()).toContain("Container health check failed");
  });

  // The e2e suite runs this binary under `execFileSync` with stdio: "pipe".
  it("writes no cursor-movement escapes off a TTY", () => {
    const h = harness({ isTTY: false });
    const step = h.reporter.step("Pulling", "warehousd:dev");
    h.advance(10);
    step.done();
    expect(h.err()).not.toContain(String.fromCharCode(27));
    expect(h.err().startsWith("\r")).toBe(false);
  });

  it("emits exactly one line per step off a TTY", () => {
    const h = harness({ isTTY: false });
    h.reporter.step("a", "1").done();
    h.reporter.step("b", "2").done();
    expect(h.err().trimEnd().split("\n")).toHaveLength(2);
  });

  it("warn and note are distinguishable", () => {
    const h = harness();
    h.reporter.note("a note");
    h.reporter.warn("a warning");
    expect(h.err()).toContain("a note");
    expect(h.err()).toContain("warning");
  });
});

describe("silentReporter", () => {
  it("accepts every call without writing anything", () => {
    expect(() => {
      const s = silentReporter.step("x", "y");
      s.done();
      s.fail();
      silentReporter.note("n");
      silentReporter.warn("w");
      silentReporter.fail("f");
      silentReporter.out("o");
    }).not.toThrow();
  });
});

// §P10. Three rules govern `update()`, and each one is a way the CLI could break something that
// already works: the e2e suite reading a pipe, the import that becomes slower than the import,
// and `--json | jq`.
describe("StepHandle.update", () => {
  it("emits nothing at all off a TTY", () => {
    const h = harness({ isTTY: false });
    const step = h.reporter.step("Importing", "people");
    const before = h.err();
    for (let i = 0; i < 10_000; i++) {
      h.advance(10);
      step.update(`${i} / 10000`);
    }
    expect(h.err()).toBe(before);
    step.done();
    // The completed step still prints its one plain line.
    expect(h.err()).toContain("Importing");
    expect(h.err()).toContain("people");
  });

  it("never writes to stdout", () => {
    const h = harness({ isTTY: true });
    const step = h.reporter.step("Importing", "people");
    h.advance(1000);
    step.update("1 / 10");
    step.done();
    expect(h.out()).toBe("");
  });

  it("throttles by wall clock, not by item", () => {
    const h = harness({ isTTY: true });
    const step = h.reporter.step("Importing", "people");
    const writesBefore = h.err().length;
    // 10,000 items across 10 simulated seconds. At ~10 writes/second that is about a hundred
    // lines, not ten thousand.
    let updates = 0;
    for (let i = 0; i < 10_000; i++) {
      h.advance(1);
      const before = h.err().length;
      step.update(`${i} / 10000`);
      if (h.err().length !== before) updates++;
    }
    expect(writesBefore).toBeGreaterThanOrEqual(0);
    expect(updates).toBeLessThanOrEqual(101);
    expect(updates).toBeGreaterThan(50);
    step.done();
  });

  it("shows the detail it was given, on stderr", () => {
    const h = harness({ isTTY: true });
    const step = h.reporter.step("Importing", "people");
    h.advance(1000);
    step.update("1,240 / 6,351 · 38s");
    expect(h.err()).toContain("1,240 / 6,351 · 38s");
    step.done();
  });

  it("is inert once the step has settled", () => {
    const h = harness({ isTTY: true });
    const step = h.reporter.step("Importing", "people");
    step.done();
    const after = h.err();
    h.advance(1000);
    step.update("late");
    expect(h.err()).toBe(after);
  });

  it("silentReporter has one too", () => {
    expect(() => silentReporter.step("x", "y").update("z")).not.toThrow();
  });
});

// Determinate work — an image pull, an import, an embedding run — knows its total, and a spinner
// is actively unhelpful there: "52%" answers the question it cannot.
describe("StepHandle.progress", () => {
  it("draws the bar into the live line on a terminal", () => {
    const err: string[] = [];
    const reporter = createReporter({
      writeErr: (s) => err.push(s),
      writeOut: () => {},
      theme: railTheme,
      isTTY: true,
      now: () => 1000,
    });
    const step = reporter.step("Pulling", "pgvector/pgvector:pg16");
    step.progress(52, 100);
    expect(err.join("")).toContain("52%");
    expect(err.join("")).toContain("█");
    step.done();
  });

  /**
   * Off a TTY it is as silent as `update()`, and for the same reason.
   *
   * A bar redrawn into a CI log ten times a second is thousands of lines of Christmas tree, and
   * the e2e suite reads that pipe and asserts what is in it. The settled line still prints.
   */
  it("emits nothing at all off a TTY", () => {
    const h = harness({ isTTY: false });
    const step = h.reporter.step("Pulling", "an image");
    for (let i = 0; i <= 100; i++) {
      h.advance(200);
      step.progress(i, 100);
    }
    expect(h.err()).toBe("");
    step.done();
    expect(h.err()).toContain("Pulling an image");
  });

  it("carries the phase label where there is one", () => {
    const err: string[] = [];
    const reporter = createReporter({
      writeErr: (s) => err.push(s),
      writeOut: () => {},
      theme: railTheme,
      isTTY: true,
      now: () => 1000,
    });
    reporter.step("Indexing", "docs").progress(3, 20, "pruning");
    expect(err.join("")).toContain("pruning");
  });
});

describe("progressBar", () => {
  it("fills in proportion, in twenty cells", () => {
    expect(progressBar(0, 100, railTheme)).toContain("░".repeat(20));
    expect(progressBar(100, 100, railTheme)).toContain("█".repeat(20));
    expect(progressBar(50, 100, railTheme)).toContain(`${"█".repeat(10)}${"░".repeat(10)}`);
  });

  it("says the percentage beside it", () => {
    expect(progressBar(52, 100, railTheme)).toContain("52%");
  });

  // Nothing to draw a bar into off a terminal, and a row of blocks in a log file is noise.
  it("is a bare percentage where there is no terminal", () => {
    expect(progressBar(52, 100, plainTheme)).toBe("52%");
  });

  it("clamps rather than overflowing on a total that was wrong", () => {
    expect(progressBar(150, 100, railTheme)).toContain("100%");
    expect(progressBar(1, 0, railTheme)).toBe("100%");
  });
});

describe("progressDetail", () => {
  it("renders count, total, elapsed and an ETA", () => {
    // 5,111 items left at 1,240 per 38s → about 157 seconds.
    expect(progressDetail({ done: 1240, total: 6351 }, 38_000)).toBe(
      "1,240 / 6,351 · 38.0s · ~156.6s left",
    );
  });

  it("omits the total where there is none", () => {
    expect(progressDetail({ done: 12 }, 500)).toBe("12 · 500ms");
  });

  it("omits the ETA once the work is done", () => {
    expect(progressDetail({ done: 10, total: 10 }, 1000)).toBe("10 / 10 · 1.0s");
  });

  it("carries a label", () => {
    expect(progressDetail({ done: 3, total: 20, label: "matters" }, 1000)).toContain("matters");
  });
});

// The counter. "Creating supabase project" says what is happening; "[4/9] Creating supabase
// project" says whether to go and make coffee — which is the question on the two long commands.
describe("plan", () => {
  function capture(isTTY: boolean) {
    const lines: string[] = [];
    const reporter = createReporter({
      writeErr: (s) => lines.push(s),
      writeOut: () => {},
      isTTY,
      now: () => 0,
    });
    return { reporter, lines };
  }

  it("numbers each step out of the declared total", () => {
    const { reporter, lines } = capture(false);
    reporter.plan(3);
    reporter.step("Creating", "one").done();
    reporter.step("Creating", "two").done();
    const out = lines.join("");
    expect(out).toContain("[1/3]  Creating one");
    expect(out).toContain("[2/3]  Creating two");
  });

  // Every command that has not opted in must look exactly as it did before.
  it("adds nothing when no plan was declared", () => {
    const { reporter, lines } = capture(false);
    reporter.step("Creating", "one").done();
    expect(lines.join("")).not.toContain("[");
  });

  // Padded to the width of the total, so the labels stay on one column — the same reason the verb
  // sits in a fixed gutter.
  it("pads the counter so the sentences stay aligned", () => {
    const { reporter, lines } = capture(false);
    reporter.plan(10);
    reporter.step("Creating", "one").done();
    expect(lines.join("")).toContain("[ 1/10]  Creating one");
  });

  it("resets on a second plan, for a command with two phases", () => {
    const { reporter, lines } = capture(false);
    reporter.plan(2);
    reporter.step("Creating", "one").done();
    reporter.plan(2);
    reporter.step("Creating", "two").done();
    expect(lines.join("")).toContain("[1/2]  Creating two");
  });
});
