import { describe, it, expect } from "vitest";
import { createReporter, silentReporter } from "../src/ui/reporter";
import { plainTheme } from "../src/ui/theme";

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
    expect(h.err()).not.toContain(plainTheme.s.ok);
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
