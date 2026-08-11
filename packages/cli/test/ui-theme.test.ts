import { describe, it, expect } from "vitest";
import { resolveTheme, plainTheme } from "../src/ui/theme";

const base = { isTTY: true, env: {} as NodeJS.ProcessEnv };

// Built from a code point so no raw control character ends up in this file, as in rc-notice.test.ts.
const ESC = String.fromCharCode(27);

describe("resolveTheme", () => {
  it("colours a TTY", () => {
    const t = resolveTheme(base);
    expect(t.colour).toBe(true);
    expect(t.c.red("x")).not.toBe("x");
  });

  it("does not colour a pipe", () => {
    const t = resolveTheme({ ...base, isTTY: false });
    expect(t.colour).toBe(false);
    expect(t.c.red("x")).toBe("x");
  });

  // https://no-color.org — presence is the signal, whatever the value, including empty.
  it.each(["1", "0", "", "true"])("honours NO_COLOR=%j", (value) => {
    const t = resolveTheme({ ...base, env: { NO_COLOR: value } });
    expect(t.colour).toBe(false);
  });

  it("honours TERM=dumb", () => {
    expect(resolveTheme({ ...base, env: { TERM: "dumb" } }).colour).toBe(false);
  });

  it("honours an explicit --no-color", () => {
    expect(resolveTheme({ ...base, noColor: true }).colour).toBe(false);
  });

  it("never colours --json, since that output is parsed", () => {
    expect(resolveTheme({ ...base, json: true }).colour).toBe(false);
  });

  it("FORCE_COLOR colours a pipe", () => {
    expect(resolveTheme({ isTTY: false, env: { FORCE_COLOR: "1" } }).colour).toBe(true);
  });

  it("FORCE_COLOR=0 does not", () => {
    expect(resolveTheme({ isTTY: false, env: { FORCE_COLOR: "0" } }).colour).toBe(false);
  });

  it("a typed --no-color beats a FORCE_COLOR the user may have forgotten", () => {
    const t = resolveTheme({ isTTY: true, env: { FORCE_COLOR: "1" }, noColor: true });
    expect(t.colour).toBe(false);
  });

  it("falls back to ASCII glyphs off a terminal", () => {
    const t = resolveTheme({ ...base, isTTY: false });
    expect(t.unicode).toBe(false);
    expect(t.s.ok).toBe("ok");
    expect(t.s.fail).toBe("x");
    expect(t.s.ellipsis).toBe("...");
  });

  it("uses unicode glyphs on a terminal", () => {
    const t = resolveTheme(base);
    expect(t.s.ok).toBe("✓");
    expect(t.s.fail).toBe("✗");
  });

  // NO_COLOR is about colour, not about glyphs: a CI log renders ✓ correctly.
  it("keeps unicode glyphs under NO_COLOR on a TTY", () => {
    const t = resolveTheme({ ...base, env: { NO_COLOR: "1" } });
    expect(t.colour).toBe(false);
    expect(t.unicode).toBe(true);
  });

  it("plainTheme is inert", () => {
    expect(plainTheme.colour).toBe(false);
    expect(plainTheme.c.bold("x")).toBe("x");
    expect(plainTheme.c.accent("x")).toBe("x");
    expect(plainTheme.c.refusal("x")).toBe("x");
  });
});

// The brand's colours are hexes (`#1D9E75`, `#D97757`), and ANSI has no name for either. Each one
// therefore has three spellings, and which one a terminal gets is the only thing these decide.
describe("brand colour depth", () => {
  it("spells the accent in 24-bit where the terminal says it can", () => {
    const t = resolveTheme({ isTTY: true, env: { COLORTERM: "truecolor" } });
    expect(t.depth).toBe(24);
    expect(t.c.accent("x")).toBe(`${ESC}[38;2;29;158;117mx${ESC}[39m`);
    expect(t.c.refusal("x")).toBe(`${ESC}[38;2;217;119;87mx${ESC}[39m`);
  });

  it("accepts COLORTERM=24bit, which some terminals set instead", () => {
    expect(resolveTheme({ isTTY: true, env: { COLORTERM: "24bit" } }).depth).toBe(24);
  });

  it("drops to the 256-colour cube on a TERM that only claims 256", () => {
    const t = resolveTheme({ isTTY: true, env: { TERM: "xterm-256color" } });
    expect(t.depth).toBe(8);
    expect(t.c.accent("x")).toBe(`${ESC}[38;5;43mx${ESC}[39m`);
    expect(t.c.refusal("x")).toBe(`${ESC}[38;5;173mx${ESC}[39m`);
  });

  it("falls back to plain green and yellow where sixteen colours is all there is", () => {
    const t = resolveTheme({ isTTY: true, env: {} });
    expect(t.depth).toBe(1);
    expect(t.c.accent("x")).toBe(`${ESC}[32mx${ESC}[39m`);
    expect(t.c.refusal("x")).toBe(`${ESC}[33mx${ESC}[39m`);
  });

  it("reads FORCE_COLOR's level, so a pipe into a pager can ask for a depth", () => {
    expect(resolveTheme({ isTTY: false, env: { FORCE_COLOR: "3" } }).depth).toBe(24);
    expect(resolveTheme({ isTTY: false, env: { FORCE_COLOR: "2" } }).depth).toBe(8);
  });

  // Depth answers "how many colours", never "any at all" — that is `colour`, and it wins.
  it("emits nothing at all under NO_COLOR, however capable the terminal claims to be", () => {
    const t = resolveTheme({ isTTY: true, env: { COLORTERM: "truecolor", NO_COLOR: "1" } });
    expect(t.c.accent("x")).toBe("x");
    expect(t.c.refusal("x")).toBe("x");
  });

  it("emits nothing under --json either, since that output is parsed", () => {
    const t = resolveTheme({ isTTY: true, env: { COLORTERM: "truecolor" }, json: true });
    expect(t.c.accent("x")).toBe("x");
  });
});
