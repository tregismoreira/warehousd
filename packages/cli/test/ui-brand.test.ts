import { describe, it, expect } from "vitest";
import { brandBanner, compactMark, wordmark } from "../src/ui/brand";
import { plainTheme, resolveTheme } from "../src/ui/theme";

// A CSI sequence: ESC [ ... final byte. Built from a code point so no raw control character ends
// up in this file, as in rc-notice.test.ts.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`);

const tty = { theme: plainTheme, isTTY: true, columns: 100 };

describe("wordmark", () => {
  const rows = wordmark(plainTheme).split("\n");

  it("is seven rows — the mark stands a row taller than the type, as it does in the SVG", () => {
    expect(rows).toHaveLength(7);
  });

  // Art is the one thing a diff cannot review. A row that drifted a character would be obvious on
  // screen and invisible in review, so the grid is asserted rather than eyeballed.
  it("draws every row to the same width", () => {
    const full = rows.filter((r) => r.length > 13);
    expect(new Set(full.map((r) => r.length)).size).toBe(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(62);
  });

  /**
   * The load-bearing one.
   *
   * In `banner.svg` columns 0–2 are discrete stacked squares and column 3 is a single unbroken
   * rect. That contrast is the mark. Rendering the bar as stacked blocks like the rest would erase
   * it, which is exactly what an edit to MARK_BLOCKS could do by accident.
   */
  it("keeps the accent bar unbroken down all seven rows", () => {
    for (const row of rows) expect(row.slice(11, 13)).toBe("██");
  });

  it("carries no ANSI when there is no terminal behind it", () => {
    expect(wordmark(plainTheme)).not.toMatch(ANSI);
  });

  it("colours the bar and nothing else", () => {
    const themed = resolveTheme({ isTTY: true, env: { COLORTERM: "truecolor" } });
    const line = wordmark(themed).split("\n")[6] ?? "";
    // One opening sequence and one close, wrapping the two bar characters alone.
    expect(line).toContain(`${ESC}[38;2;29;158;117m██${ESC}[39m`);
    expect(line.match(new RegExp(`${ESC}\\[38`, "g"))).toHaveLength(1);
  });
});

describe("compactMark", () => {
  it("keeps the name lowercase, which docs/glossary.md makes a rule", () => {
    expect(compactMark(plainTheme)).toContain("warehousd");
    expect(compactMark(plainTheme)).not.toContain("Warehousd");
    expect(compactMark(plainTheme)).not.toContain("WAREHOUSD");
  });
});

describe("brandBanner", () => {
  /**
   * The reason this module has a gate at all.
   *
   * `lifecycle.e2e.test.ts` drives the built bundle through `execFileSync` and asserts no escape
   * byte reaches either stream, and stderr is where narration goes. A plain-text fallback would
   * satisfy the colour assertion and still put six rows of decoration into everybody's CI log, so
   * off a TTY this renders nothing at all.
   */
  it("renders nothing off a terminal", () => {
    expect(brandBanner({ ...tty, isTTY: false })).toBeNull();
  });

  it("renders nothing under --quiet or --json", () => {
    expect(brandBanner({ ...tty, quiet: true })).toBeNull();
    expect(brandBanner({ ...tty, json: true })).toBeNull();
  });

  it("falls back to one line rather than wrapping, on a narrow terminal", () => {
    const narrow = brandBanner({ ...tty, columns: 40 });
    expect(narrow).not.toBeNull();
    expect(narrow?.split("\n").filter((l) => l.includes("██"))).toHaveLength(1);
  });

  it("gives up entirely where even that will not fit", () => {
    expect(brandBanner({ ...tty, columns: 12 })).toBeNull();
  });

  /**
   * A width of zero is not a narrow terminal, it is an unknown one.
   *
   * `process.stderr.columns` reports 0 — not undefined — on a pty that has not been sized, which
   * is every run under `script` and some CI runners that allocate a tty. Reading that as "too
   * narrow" suppressed the banner in exactly the places nobody would think to look.
   */
  it("treats an unsized terminal as a normal one rather than a narrow one", () => {
    expect(brandBanner({ ...tty, columns: 0 })).not.toBeNull();
    expect(brandBanner({ ...tty, columns: undefined })).not.toBeNull();
  });

  it("shows the full wordmark when there is room", () => {
    const wide = brandBanner({ ...tty, columns: 100 }) ?? "";
    expect(wide.split("\n").filter((l) => l.includes("██"))).toHaveLength(7);
  });

  // docs/glossary.md: the name is lowercase everywhere and never opens a sentence.
  it("does not open the tagline with the name", () => {
    const banner = brandBanner(tty) ?? "";
    expect(banner).not.toMatch(/(^|[.!?]\s+)warehousd/i);
  });

  it("says what the thing is, for a reader who has never seen it", () => {
    expect(brandBanner(tty)).toContain("governed data layer");
  });

  it("drops the tagline rather than wrapping it on a narrow terminal", () => {
    expect(brandBanner({ ...tty, columns: 40 })).not.toContain("governed data layer");
  });
});
