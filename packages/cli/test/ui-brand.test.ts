import { describe, it, expect } from "vitest";
import { brandBanner } from "../src/ui/brand";
import { plainTheme, resolveTheme } from "../src/ui/theme";

// A CSI sequence: ESC [ ... final byte. Built from a code point so no raw control character ends
// up in this file, as in rc-notice.test.ts.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`);

const tty = { theme: plainTheme, isTTY: true, columns: 100 };
const rows = (s: string | null) => (s ?? "").split("\n");

describe("brandBanner", () => {
  /**
   * The reason this module has a gate at all.
   *
   * `lifecycle.e2e.test.ts` drives the built bundle through `execFileSync` and asserts no escape
   * byte reaches either stream, and stderr is where narration goes. A plain-text fallback would
   * satisfy the colour assertion and still put a greeting into everybody's CI log, so off a TTY
   * this renders nothing at all.
   */
  it("renders nothing off a terminal", () => {
    expect(brandBanner({ ...tty, isTTY: false })).toBeNull();
  });

  it("renders nothing under --quiet or --json", () => {
    expect(brandBanner({ ...tty, quiet: true })).toBeNull();
    expect(brandBanner({ ...tty, json: true })).toBeNull();
  });

  it("gives up entirely where even the greeting will not fit", () => {
    expect(brandBanner({ ...tty, columns: 12 })).toBeNull();
  });

  /**
   * A width of zero is not a narrow terminal, it is an unknown one.
   *
   * `process.stderr.columns` reports 0 — not undefined — on a pty that has not been sized, which
   * is every run under `script` and some CI runners that allocate a tty. Reading that as "too
   * narrow" suppressed the banner in exactly the places nobody would think to look.
   */
  it("treats an unsized terminal as a wide one rather than a narrow one", () => {
    // Both lines, not just the greeting: guessing 80 would drop the second by two characters, in
    // exactly the environments nobody thinks to check.
    for (const columns of [0, undefined]) {
      expect(rows(brandBanner({ ...tty, columns }))).toHaveLength(2);
    }
  });

  it("greets, and says what the thing is", () => {
    const lines = rows(brandBanner(tty));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Welcome to warehousd");
    expect(lines[1]).toContain(
      "All your documents and datasets in one place, safely queryable by AI assistants.",
    );
  });

  /**
   * docs/glossary.md: the name is lowercase everywhere, including where a sentence would
   * capitalise it — which is why the greeting puts two words in front of it rather than opening
   * on it.
   */
  it("keeps the name lowercase and does not open a sentence with it", () => {
    const s = brandBanner(tty) ?? "";
    expect(s).toContain("warehousd");
    expect(s).not.toContain("Warehousd");
    expect(s).not.toMatch(/(^|[.!?]\s+)warehousd/i);
  });

  it("colours the name with the brand accent, and nothing else on that line", () => {
    const theme = resolveTheme({ isTTY: true, env: { COLORTERM: "truecolor" } });
    const line = rows(brandBanner({ ...tty, theme }))[0] ?? "";
    expect(line).toContain(`${ESC}[38;2;29;158;117mwarehousd${ESC}[39m`);
    expect(line.match(new RegExp(`${ESC}\\[38`, "g"))).toHaveLength(1);
    // "Welcome to" is not accented, only emboldened along with the rest of the line.
    expect(line).not.toContain(`${ESC}[38;2;29;158;117mWelcome`);
  });

  it("carries no ANSI when there is no terminal behind it", () => {
    expect(brandBanner(tty)).not.toMatch(ANSI);
  });

  // Dropped rather than rewrapped: a sentence the terminal rewraps lands differently on every
  // machine, which is the same reason the release-candidate notice breaks at its own sentence.
  it("drops the blurb rather than wrapping it on a narrow terminal", () => {
    const narrow = brandBanner({ ...tty, columns: 40 }) ?? "";
    expect(rows(narrow)).toHaveLength(1);
    expect(narrow).toContain("Welcome to warehousd");
    expect(narrow).not.toContain("documents and datasets");
  });

  it("indents to the same column as every panel, notice and progress line", () => {
    for (const line of rows(brandBanner(tty))) expect(line).toMatch(/^ {2}\S/);
  });

  // Same contract as rcNotice and formatExplained, for the same reason: what sits above this
  // varies, and only the caller knows. A newline at either end would double up with one of them.
  it("brings no blank line of its own", () => {
    const s = brandBanner(tty) ?? "";
    expect(s.startsWith("\n")).toBe(false);
    expect(s.endsWith("\n")).toBe(false);
  });

  it("leaves no trailing whitespace", () => {
    for (const line of rows(brandBanner(tty))) expect(line).toBe(line.trimEnd());
  });
});
