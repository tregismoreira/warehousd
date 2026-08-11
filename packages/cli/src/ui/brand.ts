import type { Theme } from "./theme";

// The wordmark, transcribed from `.github/assets/banner.svg` rather than invented.
//
// Pure, like the rest of this directory: it takes a Theme and a column count and returns a string,
// so what the terminal shows can be asserted without a terminal. Nothing here reads `process`.
//
// The one rule that matters more than how it looks: **off a TTY this renders nothing at all**, not
// a plain-text fallback. `packages/cli/test/e2e/lifecycle.e2e.test.ts` asserts that a piped `start`
// carries no escape byte on either stream, and the stdout/stderr split (narration on stderr, the
// product on stdout) is what makes `warehousd start --json | jq` work. Decoration nobody asked for
// has no business in either.

/**
 * The mark: a 4×4 grid, on a 47.114 pitch with 38.658 blocks, so there is a gutter on both axes.
 *
 * Columns 0–2 are discrete stacked squares — column 0 filled on every row, column 1 on the last
 * row alone, column 2 on the last two. **Column 3 is not a stack.** It is one unbroken rect
 * running the full height of the mark, and it is the only part in the accent colour. That contrast
 * is the whole idea: loose blocks accumulating against a single solid boundary.
 *
 * A terminal cell is roughly half as wide as it is tall, so one grid cell is two characters wide
 * and the horizontal gutters come free at a pitch of three. The vertical ones do not: at one row
 * per grid row the stacked squares would abut and read as a solid column, erasing the distinction
 * above. So each grid row gets a block row and a gutter row, and the bar — which has no gutters to
 * draw — is filled on both.
 *
 * The bar is stored apart from the blocks rather than baked into these strings. It is what keeps
 * "the bar is continuous" a property of the structure instead of something seven string literals
 * happen to agree on, and `ui-brand.test.ts` asserts it.
 */
const MARK_BLOCKS = [
  "██       ",
  "         ",
  "██       ",
  "         ",
  "██    ██ ",
  "         ",
  "██ ██ ██ ",
] as const;

const MARK_BAR = "██";

/**
 * Lowercase letterforms, because `docs/glossary.md` makes that a rule rather than a preference —
 * the name is lowercase everywhere, including where a sentence would capitalise it.
 *
 * That rule is also why this is hand-drawn. Block fonts render lowercase input as uppercase
 * shapes, so every one of them would spell the name wrong.
 *
 * Six rows. The top two are the ascender zone and only `h` and `d` reach into them; the lower four
 * are x-height. Four cells per letter, five for `w`, one blank column between them.
 */
const GLYPHS: Record<string, readonly string[]> = {
  w: ["     ", "     ", "█   █", "█   █", "█ █ █", " █ █ "],
  a: ["    ", "    ", " ██ ", "█  █", "█  █", " ███"],
  r: ["    ", "    ", "█ ██", "██  ", "█   ", "█   "],
  e: ["    ", "    ", " ██ ", "█  █", "████", " ██ "],
  h: ["█   ", "█   ", "█   ", "███ ", "█  █", "█  █"],
  o: ["    ", "    ", " ██ ", "█  █", "█  █", " ██ "],
  u: ["    ", "    ", "█  █", "█  █", "█  █", " ███"],
  s: ["    ", "    ", " ███", "██  ", "  ██", "███ "],
  d: ["   █", "   █", " ███", "█  █", "█  █", " ███"],
};

const NAME = "warehousd";

/** One blank column between letters, and four between the mark and the type. */
const LETTER_GAP = " ";
const MARK_GAP = "    ";

const INDENT = "  ";

/**
 * What it is, in one line, for the reader who has never seen this before.
 *
 * It must not open with the name — see `docs/glossary.md`, and `rc-notice.ts` for the same
 * constraint solved the same way.
 */
const TAGLINE = "an MCP-ready governed data layer — safely queryable by AI";

/** The six rows of `warehousd`, 45 columns wide. */
function typeRows(): string[] {
  const rows: string[] = [];
  for (let row = 0; row < 6; row += 1) {
    rows.push([...NAME].map((ch) => GLYPHS[ch]?.[row] ?? "").join(LETTER_GAP));
  }
  return rows;
}

/**
 * Mark and type together, baseline-aligned.
 *
 * The mark is a row taller than the type — as it is in the SVG, where it spans 180 units against
 * the wordmark's ~113 — so the type sits on rows 1–6 against the mark's 0–6 and the two share a
 * baseline on the last row.
 *
 * Rows are built and trimmed individually rather than written as one template literal: several end
 * in whitespace that is invisible in a diff and that an editor or Prettier would silently rewrite.
 */
export function wordmark(theme: Theme): string {
  const type = typeRows();
  return MARK_BLOCKS.map((blocks, row) => {
    const mark = `${blocks}${theme.c.accent(MARK_BAR)}`;
    const line = row === 0 ? mark : `${mark}${MARK_GAP}${type[row - 1] ?? ""}`;
    return `${INDENT}${line}`.trimEnd();
  }).join("\n");
}

/** The mark's last row and the name as text, for a terminal too narrow for the full thing. */
export function compactMark(theme: Theme): string {
  const last = MARK_BLOCKS[MARK_BLOCKS.length - 1] ?? "";
  return `${INDENT}${last}${theme.c.accent(MARK_BAR)}  ${theme.c.bold(NAME)}`;
}

/** Widest row of the full wordmark, plus its indent. */
const WIDE_COLUMNS = INDENT.length + 11 + MARK_GAP.length + 45;
const COMPACT_COLUMNS = INDENT.length + 11 + 2 + NAME.length;

export type BannerInput = {
  theme: Theme;
  isTTY: boolean;
  quiet?: boolean | undefined;
  json?: boolean | undefined;
  /** Injected rather than read from `process`, so this stays assertable at any width. */
  columns?: number | undefined;
};

/**
 * The opening banner for `init`, `start` and `restart`, or `null` where it does not belong.
 *
 * `null` covers three cases and one of them is load-bearing. Under `--quiet` and `--json` it is
 * noise the caller has asked not to receive. Off a TTY it is worse than noise: see the header.
 */
export function brandBanner(input: BannerInput): string | null {
  if (!input.isTTY || input.quiet === true || input.json === true) return null;

  // `??` is not enough: `process.stderr.columns` is **0**, not undefined, on a pty that has not
  // been sized yet — which is every run under `script`, and some CI runners that allocate a tty.
  // Zero is not a narrow terminal, it is an unknown one, and treating it as narrow silently
  // suppressed the banner everywhere it was hardest to notice.
  const columns = input.columns !== undefined && input.columns > 0 ? input.columns : 80;
  if (columns < COMPACT_COLUMNS) return null;

  const { theme } = input;
  const art = columns >= WIDE_COLUMNS ? wordmark(theme) : compactMark(theme);
  const tagline =
    columns >= INDENT.length + TAGLINE.length ? `\n${INDENT}${theme.c.dim(TAGLINE)}` : "";
  return `\n${art}\n${tagline}`;
}
