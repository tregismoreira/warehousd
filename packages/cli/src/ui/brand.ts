import type { Theme } from "./theme";

// The greeting `init`, `start` and `restart` open with.
//
// Pure, like the rest of this directory: it takes a Theme and a column count and returns a string,
// so what the terminal shows can be asserted without a terminal. Nothing here reads `process`.
//
// The one rule that matters more than how it looks: **off a TTY this renders nothing at all**, not
// a plain-text fallback. `packages/cli/test/e2e/lifecycle.e2e.test.ts` asserts that a piped `start`
// carries no escape byte on either stream, and the stdout/stderr split (narration on stderr, the
// product on stdout) is what makes `warehousd start --json | jq` work. Decoration nobody asked for
// has no business in either.
//
// **Nothing here is drawn.** There was an ASCII wordmark, and then a mark transcribed from
// `.github/assets/banner.svg`, and both were worse than the words. The reason is arithmetic: a
// terminal cell is about one unit wide and two tall, so a letter stroke one character by one row
// renders at 1×2 and every glyph comes out stretched — at the size nine letters have to fit into,
// `a`, `o` and `e` become the same shape. Half-blocks buy the vertical resolution back and fix the
// mark's proportions, but a four-square stack beside a bar is a logo that needs its own legend at
// 12 pixels. Two lines of type say more, in less room, at every width.

const GREETING = "Welcome to ";
const NAME = "warehousd";

/**
 * What the product is, from README.md's own sentence.
 *
 * "Welcome to warehousd" is also how the lowercase rule is kept: `docs/glossary.md` requires the
 * name never open a sentence, and a greeting puts two words in front of it without contortion.
 */
const BLURB = "All your documents and datasets in one place, safely queryable by AI assistants.";

const INDENT = "  ";

const GREETING_COLUMNS = INDENT.length + GREETING.length + NAME.length;
const BLURB_COLUMNS = INDENT.length + BLURB.length;

/**
 * What to assume when the terminal will not say how wide it is.
 *
 * Wide enough for both lines, on the same principle as the zero-width case below: an unsized
 * terminal is an unknown one, not a narrow one, and guessing narrow silently drops content in
 * exactly the environments nobody thinks to check. 80 would be a guess that loses the second line
 * by two characters.
 */
const ASSUMED_COLUMNS = Math.max(80, BLURB_COLUMNS);

export type BannerInput = {
  theme: Theme;
  isTTY: boolean;
  quiet?: boolean | undefined;
  json?: boolean | undefined;
  /** Injected rather than read from `process`, so this stays assertable at any width. */
  columns?: number | undefined;
};

/**
 * The greeting, or `null` where it does not belong.
 *
 * `null` covers three cases and one of them is load-bearing. Under `--quiet` and `--json` it is
 * noise the caller has asked not to receive. Off a TTY it is worse than noise: see the header.
 *
 * No blank line of its own at either end. The caller owns the spacing, because what sits above
 * this varies — the release-candidate notice, or nothing once that retires at 1.0.
 */
export function brandBanner(input: BannerInput): string | null {
  if (!input.isTTY || input.quiet === true || input.json === true) return null;

  // `??` is not enough: `process.stderr.columns` is **0**, not undefined, on a pty that has not
  // been sized yet — which is every run under `script`, and some CI runners that allocate a tty.
  // Zero is not a narrow terminal, it is an unknown one, and treating it as narrow silently
  // suppressed the banner everywhere it was hardest to notice.
  const columns =
    input.columns !== undefined && input.columns > 0 ? input.columns : ASSUMED_COLUMNS;
  if (columns < GREETING_COLUMNS) return null;

  const { theme } = input;
  const lines = [`${INDENT}${theme.c.bold(`${GREETING}${theme.c.accent(NAME)}`)}`];
  // Dropped rather than wrapped: a sentence rewrapped by the terminal lands differently on every
  // machine, which is the same reason the release-candidate notice breaks at its own sentence.
  if (columns >= BLURB_COLUMNS) lines.push(`${INDENT}${theme.c.dim(BLURB)}`);
  return lines.join("\n");
}
