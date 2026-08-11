import { describe, it, expect } from "vitest";
import { initIntro, wrap } from "../src/ui/brand";
import { resolveTheme } from "../src/ui/theme";

// A CSI sequence: ESC [ ... final byte. Built from a code point so no raw control character ends
// up in this file, as in rc-notice.test.ts.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`);

// `initIntro` opens a frame, so it needs a theme that has one: `plainTheme` is the piped rendering
// and deliberately draws no rail at all.
const ttyTheme = resolveTheme({ isTTY: true, env: { NO_COLOR: "1" } });
const tty = { theme: ttyTheme, isTTY: true, columns: 100 };
const rows = (s: string | null) => (s ?? "").split("\n");

describe("initIntro", () => {
  /**
   * The reason this module has a gate at all.
   *
   * `lifecycle.e2e.test.ts` drives the built bundle through `execFileSync` and asserts no escape
   * byte reaches either stream. A plain-text fallback would satisfy the colour assertion and still
   * put a greeting into everybody's CI log, so off a TTY this renders nothing at all.
   */
  it("renders nothing off a terminal", () => {
    expect(initIntro({ ...tty, isTTY: false })).toBeNull();
  });

  it("renders nothing under --quiet or --json", () => {
    expect(initIntro({ ...tty, quiet: true })).toBeNull();
    expect(initIntro({ ...tty, json: true })).toBeNull();
  });

  it("gives up entirely where even the greeting will not fit", () => {
    expect(initIntro({ ...tty, columns: 12 })).toBeNull();
  });

  /**
   * A width of zero is not a narrow terminal, it is an unknown one.
   *
   * `process.stdout.columns` reports 0 — not undefined — on a pty that has not been sized, which
   * is every run under `script` and some CI runners that allocate a tty. Reading that as "too
   * narrow" suppressed the greeting in exactly the places nobody would think to look.
   */
  it("treats an unsized terminal as a wide one rather than a narrow one", () => {
    for (const columns of [0, undefined]) {
      const lines = rows(initIntro({ ...tty, columns }));
      expect(lines[0]).toContain("Welcome to warehousd");
      expect(lines.join("\n")).toContain("documents and datasets");
    }
  });

  // The complaint this replaces: the old banner floated above the wizard with a blank line
  // between them, so the first thing a new user saw was a greeting attached to nothing.
  it("opens the frame the wizard then hangs from", () => {
    const lines = rows(initIntro(tty));
    expect(lines[0]).toBe(`${ttyTheme.s.top}  Welcome to warehousd`);
    for (const line of lines.slice(1)) expect(line.startsWith(ttyTheme.s.bar)).toBe(true);
  });

  it("says what the thing is, and what the wizard is about to do", () => {
    const s = initIntro(tty) ?? "";
    expect(s).toContain("All your documents and datasets in one place");
    expect(s).toContain("warehousd.yml");
    expect(s).toContain("Ctrl+C quits");
  });

  /**
   * docs/glossary.md: the name is lowercase everywhere, including where a sentence would
   * capitalise it — which is why the greeting puts two words in front of it rather than opening
   * on it.
   */
  it("keeps the name lowercase and does not open a sentence with it", () => {
    const s = initIntro(tty) ?? "";
    expect(s).toContain("warehousd");
    expect(s).not.toContain("Warehousd");
    expect(s).not.toMatch(/(^|[.!?]\s+)warehousd/i);
  });

  it("colours the name with the brand accent, and nothing else on that line", () => {
    const theme = resolveTheme({ isTTY: true, env: { COLORTERM: "truecolor" } });
    const line = rows(initIntro({ ...tty, theme }))[0] ?? "";
    expect(line).toContain(`${ESC}[38;2;29;158;117mwarehousd${ESC}[39m`);
    expect(line.match(new RegExp(`${ESC}\\[38`, "g"))).toHaveLength(1);
    // "Welcome to" is not accented, only emboldened along with the rest of the line.
    expect(line).not.toContain(`${ESC}[38;2;29;158;117mWelcome`);
  });

  it("carries no ANSI when colour is off", () => {
    expect(initIntro(tty)).not.toMatch(ANSI);
  });

  /**
   * Wrapped rather than dropped, which is the one thing that changed about the prose.
   *
   * The old banner dropped its second line on a narrow terminal because a sentence rewrapped by
   * the terminal lands differently on every machine. Inside a frame the text has a width to wrap
   * *to*, so it lands the same way everywhere and nothing has to be thrown away.
   */
  it("wraps the prose to the frame rather than letting the terminal do it", () => {
    const narrow = rows(initIntro({ ...tty, columns: 40 }));
    expect(narrow.length).toBeGreaterThan(rows(initIntro(tty)).length);
    for (const line of narrow) expect(line.length).toBeLessThanOrEqual(40);
    expect(narrow.join("\n")).toContain("documents and datasets");
  });

  // Same contract as rcNotice and formatExplained, for the same reason: what sits above this
  // varies, and only the caller knows. A newline at either end would double up with one of them.
  it("brings no blank line of its own", () => {
    const s = initIntro(tty) ?? "";
    expect(s.startsWith("\n")).toBe(false);
    expect(s.endsWith("\n")).toBe(false);
  });

  it("leaves no trailing whitespace", () => {
    for (const line of rows(initIntro(tty))) expect(line).toBe(line.trimEnd());
  });
});

describe("wrap", () => {
  it("breaks at spaces and never past the width", () => {
    for (const line of wrap("one two three four five six seven", 12)) {
      expect(line.length).toBeLessThanOrEqual(12);
    }
  });

  it("keeps a word longer than the width rather than cutting it", () => {
    expect(wrap("supercalifragilistic", 5)).toEqual(["supercalifragilistic"]);
  });

  it("loses no words", () => {
    const text = "one two three four five six seven";
    expect(wrap(text, 9).join(" ")).toBe(text);
  });
});
