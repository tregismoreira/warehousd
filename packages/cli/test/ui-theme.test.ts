import { describe, it, expect } from "vitest";
import { resolveTheme, plainTheme } from "../src/ui/theme";

const base = { isTTY: true, env: {} as NodeJS.ProcessEnv };

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
  });
});
