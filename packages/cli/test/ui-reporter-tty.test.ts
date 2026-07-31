import { describe, it, expect, vi, afterEach } from "vitest";
import { createReporter } from "../src/ui/reporter";
import { resolveTheme, plainTheme } from "../src/ui/theme";

// The animated path. Split from ui-reporter.test.ts because it needs fake timers, and a suite
// that installs them for every test makes the plain assertions harder to read than they should be.

const ESC = String.fromCharCode(27);

afterEach(() => {
  vi.useRealTimers();
});

function harness(theme = plainTheme) {
  const err: string[] = [];
  let t = 0;
  return {
    err: () => err.join(""),
    advance: (ms: number) => {
      t += ms;
    },
    reporter: createReporter({
      writeErr: (s) => err.push(s),
      writeOut: () => {},
      theme,
      isTTY: true,
      now: () => t,
    }),
  };
}

describe("createReporter on a TTY", () => {
  it("paints immediately rather than waiting for the first tick", () => {
    vi.useFakeTimers();
    const h = harness();
    h.reporter.step("Pulling", "warehousd:dev");
    expect(h.err()).toContain("warehousd:dev");
  });

  it("repaints in place, never scrolling a line per frame", () => {
    vi.useFakeTimers();
    const h = harness(resolveTheme({ isTTY: true, env: {} }));
    h.reporter.step("Waiting", "health check");
    vi.advanceTimersByTime(400);
    const painted = h.err();
    // Every repaint is preceded by an erase-line, so the frames overwrite one another.
    expect(painted.split(`${ESC}[2K`).length).toBeGreaterThan(2);
    expect(painted.split("\n")).toHaveLength(1);
  });

  it("stops the timer once the step settles", () => {
    vi.useFakeTimers();
    const h = harness();
    const step = h.reporter.step("Waiting", "health check");
    vi.advanceTimersByTime(200);
    step.done();
    const afterSettle = h.err();
    vi.advanceTimersByTime(1000);
    expect(h.err()).toBe(afterSettle);
  });

  it("clears the spinner line before writing the settled one", () => {
    vi.useFakeTimers();
    const h = harness();
    const step = h.reporter.step("Starting", "server");
    h.advance(500);
    step.done();
    expect(h.err()).toContain(`${ESC}[2K`);
    expect(h.err().trimEnd().endsWith("500ms")).toBe(true);
  });

  it("clears the line before an out-of-band failure message too", () => {
    vi.useFakeTimers();
    const h = harness();
    h.reporter.step("Waiting", "health check");
    h.reporter.fail("boom");
    expect(h.err()).toContain("boom");
  });

  it("does not animate when quiet, but still settles", () => {
    vi.useFakeTimers();
    const h = harness();
    const step = h.reporter.step("Pulling", "x");
    step.done();
    expect(h.err()).toContain("Pulling");
  });
});
