import type { Theme } from "./theme";
import { frameOpen, rail } from "./frame";

// The frame `init` opens on: a greeting, what the product is, and what the next two minutes are
// going to consist of.
//
// It used to be a banner that `init`, `start` and `restart` all printed, floating above the wizard
// with a blank line between them — so the first thing a new user saw was a greeting attached to
// nothing, and then a separate program's prompts. It is the top of the frame now, and the wizard's
// own rail continues straight down from it. `start` and `restart` open on their own command name
// instead: they have a beginning, but not a welcome.
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
// renders at 1×2 and every glyph comes out stretched. Two lines of type say more, in less room, at
// every width.

const GREETING = "Welcome to ";
const NAME = "warehousd";

/**
 * What the product is, from README.md's own sentence.
 *
 * "Welcome to warehousd" is also how the lowercase rule is kept: `docs/glossary.md` requires the
 * name never open a sentence, and a greeting puts two words in front of it without contortion.
 */
const BLURB = "All your documents and datasets in one place, safely queryable by AI assistants.";

/**
 * What the wizard is about to do, where the answers go, and how to leave.
 *
 * Atlassian's ninth principle — provide an easy way out — and the answer to the question a first
 * run actually raises, which is not "what is warehousd" but "is this about to write something".
 */
const WHAT_HAPPENS = [
  "The steps below set up this folder as a project. Answers are written to warehousd.yml — you can change any of them there later.",
  "Ctrl+C quits at any point; nothing is written until the end.",
];

/** The rail eats three columns, and prose past this is harder to read, not easier. */
const MAX_TEXT_COLUMNS = 72;
const RAIL_COLUMNS = 3;

/**
 * What to assume when the terminal will not say how wide it is.
 *
 * An unsized terminal is an unknown one, not a narrow one, and guessing narrow silently drops
 * content in exactly the environments nobody thinks to check.
 */
const ASSUMED_COLUMNS = 80;

/** Below this there is no room for a frame at all, and the greeting alone is the whole intro. */
const MIN_COLUMNS = RAIL_COLUMNS + GREETING.length + NAME.length;

export type IntroInput = {
  theme: Theme;
  isTTY: boolean;
  quiet?: boolean | undefined;
  json?: boolean | undefined;
  /** Injected rather than read from `process`, so this stays assertable at any width. */
  columns?: number | undefined;
};

/**
 * The opening of the `init` frame, or `null` where it does not belong.
 *
 * `null` covers three cases and one of them is load-bearing. Under `--quiet` and `--json` it is
 * noise the caller has asked not to receive. Off a TTY it is worse than noise: see the header.
 *
 * No blank line of its own at either end. The caller owns the spacing, because what sits above
 * this varies — the release-candidate notice, or nothing once that retires at 1.0.
 */
export function initIntro(input: IntroInput): string | null {
  if (!input.isTTY || input.quiet === true || input.json === true) return null;

  // `??` is not enough: `process.stderr.columns` is **0**, not undefined, on a pty that has not
  // been sized yet — which is every run under `script`, and some CI runners that allocate a tty.
  // Zero is not a narrow terminal, it is an unknown one, and treating it as narrow silently
  // suppressed the banner everywhere it was hardest to notice.
  const columns =
    input.columns !== undefined && input.columns > 0 ? input.columns : ASSUMED_COLUMNS;
  if (columns < MIN_COLUMNS) return null;

  const { theme } = input;
  const width = Math.min(MAX_TEXT_COLUMNS, columns - RAIL_COLUMNS);
  const open = frameOpen(`${GREETING}${theme.c.accent(NAME)}`, theme);

  // Wrapped rather than dropped, unlike the banner this replaces: inside a frame the text has a
  // known width to wrap to, so it lands the same way on every terminal instead of being at the
  // mercy of one.
  const body = [
    "",
    ...wrap(BLURB, width).map((l) => theme.c.dim(l)),
    "",
    ...WHAT_HAPPENS.flatMap((p) => wrap(p, width)).map((l) => theme.c.dim(l)),
  ];

  return [open, rail(body, theme)].filter((s): s is string => s !== null).join("\n");
}

/** Greedy word wrap. Long enough for two sentences, and nothing here has a word past 20 columns. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}
