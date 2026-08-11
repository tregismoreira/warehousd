import { describe, it, expect } from "vitest";
import { isPrerelease, rcNotice } from "../src/ui/rc-notice";
import { plainTheme, resolveTheme } from "../src/ui/theme";

// A CSI sequence: ESC [ ... final byte. Built from a code point so no raw control character ends
// up in this file.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);

describe("isPrerelease", () => {
  it("reads the version that is actually shipping today", () => {
    expect(isPrerelease("0.1.0-rc.1")).toBe(true);
  });

  // The tsup define falls back to this when the CLI runs from source rather than the bundle, and
  // an unbuilt checkout is the last place to imply something is production-ready.
  it("counts the source-run fallback as one", () => {
    expect(isPrerelease("0.0.0-dev")).toBe(true);
  });

  it("does not count a stable version", () => {
    expect(isPrerelease("1.0.0")).toBe(false);
    expect(isPrerelease("0.1.0")).toBe(false);
  });
});

describe("rcNotice", () => {
  it("says what someone is running, and where to read the rest", () => {
    const s = rcNotice("0.1.0-rc.1", plainTheme);
    expect(s).toContain("release candidate");
    expect(s).toContain("not meant to be used in production");
    expect(s).toContain("https://github.com/tregismoreira/warehousd");
  });

  // The reason this module exists: every command, not just `init` and `start`, and the line has to
  // survive a release without anyone remembering to edit it.
  it("names no version, so a bump cannot make it lie", () => {
    expect(rcNotice("0.1.0-rc.1", plainTheme)).not.toContain("0.1.0-rc.1");
  });

  // docs/glossary.md: the name is lowercase everywhere and never opens a sentence.
  it("does not open a sentence with the name", () => {
    expect(rcNotice("0.1.0-rc.1", plainTheme)).not.toMatch(/(^|[.!?]\s+)warehousd/i);
  });

  it("goes quiet on a stable release rather than waiting to be deleted", () => {
    expect(rcNotice("1.0.0", plainTheme)).toBeNull();
  });

  it("carries no ANSI when there is no terminal behind it", () => {
    expect(rcNotice("0.1.0-rc.1", plainTheme)).not.toMatch(ANSI);
  });

  it("dims itself when there is", () => {
    const theme = resolveTheme({ isTTY: true, env: {} });
    expect(rcNotice("0.1.0-rc.1", theme)).toMatch(ANSI);
  });

  /**
   * It used to be one flush-left line of 128 characters.
   *
   * That put it at column 0 where it collided with the shell prompt and lined up with none of the
   * output beneath it, and it wrapped wherever the terminal happened to be — so the URL landed in
   * a different place on every machine. Both are layout, and layout is what these pin.
   */
  it("breaks at the sentence, so the link is not at the mercy of the terminal width", () => {
    const lines = (rcNotice("0.1.0-rc.1", plainTheme) ?? "").split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("not meant to be used in production");
    expect(lines[1]).toContain("https://github.com/tregismoreira/warehousd");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("indents to the same column as every panel and progress line", () => {
    const lines = (rcNotice("0.1.0-rc.1", plainTheme) ?? "").split("\n");
    for (const line of lines) expect(line).toMatch(/^ {2}\S|^ {4}\S/);
  });

  it("carries the warning glyph, so it reads as a warning rather than as noise", () => {
    expect(rcNotice("0.1.0-rc.1", plainTheme)).toContain(`  ${plainTheme.s.warn} This is`);
  });

  // The second line aligns under the text, not under the glyph, so the two read as one block.
  it("aligns the continuation under the first line's text", () => {
    const lines = (rcNotice("0.1.0-rc.1", plainTheme) ?? "").split("\n");
    const textStarts = (l: string) => l.length - l.trimStart().length;
    expect(textStarts(lines[1] ?? "")).toBe(textStarts(lines[0] ?? "") + 2);
  });

  // Blank lines belong to the caller: what follows is sometimes a wordmark, sometimes a panel that
  // opens with its own, so a leading or trailing newline here would double up in one of the two.
  it("brings no blank line of its own", () => {
    const s = rcNotice("0.1.0-rc.1", plainTheme) ?? "";
    expect(s.startsWith("\n")).toBe(false);
    expect(s.endsWith("\n")).toBe(false);
  });
});
