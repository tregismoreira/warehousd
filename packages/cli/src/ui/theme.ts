import pc from "picocolors";

// Every colour and glyph decision the CLI makes, resolved once from the environment and then
// passed down. Nothing below this module reads `process.stdout.isTTY` or `NO_COLOR` again — a
// renderer that consults the environment on its own is a renderer that cannot be tested without
// mutating the environment.

export type Palette = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  /** The brand's own green (`#1D9E75`) — the accent bar in `.github/assets/banner.svg`. */
  accent: (s: string) => string;
  /**
   * The brand's `#D97757`, and a distinction the product already makes.
   *
   * `red` is a failure: something broke and nothing can continue. A refusal is a decision — the
   * broker was asked and said no, which is the system working. Colouring the two the same teaches
   * an operator to read a governed denial as an outage.
   */
  refusal: (s: string) => string;
};

/**
 * How many colours the terminal behind us can actually show.
 *
 * 1 is the sixteen ANSI colours every terminal has had since the 1980s, 8 is the 256-colour cube,
 * 24 is truecolor. It matters because the brand colours are hexes: `#1D9E75` has no ANSI name, so
 * it degrades to the nearest cube entry and then to plain green. Resolved once, here, for the same
 * reason `colour` and `unicode` are.
 */
export type ColourDepth = 1 | 8 | 24;

export type Symbols = {
  ok: string;
  fail: string;
  warn: string;
  pending: string;
  ellipsis: string;
  /** The frame's opening corner — `┌  warehousd start`. */
  top: string;
  /** The rail every line inside a frame hangs from. */
  bar: string;
  /** The frame's closing corner, which always carries the what-next sentence. */
  bottom: string;
  /** A finished step or a fact that needed nothing done about it. */
  done: string;
};

/**
 * One glyph per concept, reused everywhere that concept appears.
 *
 * Content-level, unlike `Symbols`: these sit beside a label rather than in the glyph column, and
 * they are **dropped entirely** rather than faked in ASCII. A terminal that cannot render an
 * emoji is one where `[DB]` would be noise, not help — the label already says "Database".
 */
export type Icons = {
  running: string;
  ready: string;
  admin: string;
  api: string;
  mcp: string;
  env: string;
  database: string;
  secrets: string;
  login: string;
  data: string;
  docs: string;
  doctor: string;
};

export type Theme = {
  colour: boolean;
  unicode: boolean;
  depth: ColourDepth;
  c: Palette;
  s: Symbols;
  i: Icons;
};

export type ThemeInput = {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  noColor?: boolean | undefined;
  json?: boolean | undefined;
};

const identity = (s: string): string => s;

const PLAIN: Palette = {
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  cyan: identity,
  accent: identity,
  refusal: identity,
};

// `createColors(true)` rather than picocolors' default export. The default runs its own TTY and
// NO_COLOR detection once, at import, and returns identity functions when it decides against
// colour — which would quietly override every decision resolveTheme just made, and made this
// module untestable (a unit test has no TTY, so `colour: true` still produced plain strings).
// Detection belongs in resolveTheme; this is only the escape codes.
const forced = pc.createColors(true);

/**
 * The two brand colours, and what each degrades to.
 *
 * Written as escape codes by hand because picocolors has no hex API and `packages/cli` is meant to
 * stay thin (AGENTS.md: ask before adding a dependency). The 256-colour entries are the nearest
 * points in the 6×6×6 cube — `#00af87` for the accent, `#d7875f` for the refusal — and the
 * sixteen-colour fallbacks are the closest names the standard has.
 */
type BrandColour = { rgb: [number, number, number]; cube: number; basic: string };

const ACCENT: BrandColour = { rgb: [29, 158, 117], cube: 43, basic: "32" };
const REFUSAL: BrandColour = { rgb: [217, 119, 87], cube: 173, basic: "33" };

// Default foreground, not "reset everything": these wrap text that may already be bold or dim, and
// `\x1b[0m` would drop that as well.
const RESET = "\x1b[39m";

function brand(colour: BrandColour, depth: ColourDepth): (s: string) => string {
  const open =
    depth === 24
      ? `\x1b[38;2;${colour.rgb[0]};${colour.rgb[1]};${colour.rgb[2]}m`
      : depth === 8
        ? `\x1b[38;5;${colour.cube}m`
        : `\x1b[${colour.basic}m`;
  return (s) => `${open}${s}${RESET}`;
}

function colourPalette(depth: ColourDepth): Palette {
  return {
    bold: (s) => forced.bold(s),
    dim: (s) => forced.dim(s),
    red: (s) => forced.red(s),
    green: (s) => forced.green(s),
    yellow: (s) => forced.yellow(s),
    cyan: (s) => forced.cyan(s),
    accent: brand(ACCENT, depth),
    refusal: brand(REFUSAL, depth),
  };
}

const UNICODE_SYMBOLS: Symbols = {
  ok: "✓",
  fail: "■",
  warn: "▲",
  pending: "·",
  ellipsis: "…",
  top: "┌",
  bar: "│",
  bottom: "└",
  done: "◇",
};

// The rail degrades to the pipe and the asterisk rather than disappearing: a piped run draws no
// frame at all, but a `TERM=dumb` terminal still gets something that lines up.
const ASCII_SYMBOLS: Symbols = {
  ok: "ok",
  fail: "x",
  warn: "!",
  pending: "-",
  ellipsis: "...",
  top: "*",
  bar: "|",
  bottom: "*",
  done: "o",
};

// `🖥` and `🗄` default to *text* presentation in Unicode, so a terminal is free to draw either as
// a narrow monochrome glyph while every other icon here is two cells wide — and one narrow icon in
// a column of wide ones takes the values out of line. U+FE0F asks for the emoji presentation, and
// `displayWidth` in ui/frame.ts counts it as nothing.
const UNICODE_ICONS: Icons = {
  running: "🚀",
  ready: "✨",
  admin: "🖥️",
  api: "⚡",
  mcp: "🤖",
  env: "🌱",
  database: "🗄️",
  secrets: "🔑",
  login: "👤",
  data: "📦",
  docs: "📚",
  doctor: "🩺",
};

const NO_ICONS: Icons = {
  running: "",
  ready: "",
  admin: "",
  api: "",
  mcp: "",
  env: "",
  database: "",
  secrets: "",
  login: "",
  data: "",
  docs: "",
  doctor: "",
};

// https://no-color.org — presence is the signal, whatever the value. FORCE_COLOR is the escape
// hatch for someone piping into a pager that does understand escapes, but an explicit --no-color
// still wins over it: a flag the user typed beats a variable they may have forgotten.
export function resolveTheme(input: ThemeInput): Theme {
  const { isTTY, env } = input;

  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  const suppressed =
    input.noColor === true ||
    input.json === true ||
    env.NO_COLOR !== undefined ||
    env.TERM === "dumb";

  const colour = suppressed ? false : forced || isTTY;
  // Glyphs follow the terminal, not the colour setting: a CI log with NO_COLOR set still renders
  // a ✓ correctly, but a pipe into a file that someone greps later is better off with ASCII.
  const unicode = env.TERM !== "dumb" && (isTTY || forced);
  const depth = colourDepth(env);

  return {
    colour,
    unicode,
    depth,
    c: colour ? colourPalette(depth) : PLAIN,
    s: unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS,
    i: unicode ? UNICODE_ICONS : NO_ICONS,
  };
}

/**
 * How many colours to assume, from the two variables that are allowed to say.
 *
 * Only consulted when colour is on at all, so there is no rung here for "none" — `colour: false`
 * already returns PLAIN and the depth is then a number nothing reads.
 *
 * `COLORTERM` is the de-facto truecolor signal and the one every modern terminal sets. `TERM`
 * naming `256color` is the older convention and still what tmux and most SSH sessions advertise.
 * `FORCE_COLOR` follows the level convention the ecosystem settled on — 3 is truecolor, 2 is 256 —
 * so someone piping into a pager can ask for a depth as well as for colour at all.
 */
function colourDepth(env: NodeJS.ProcessEnv): ColourDepth {
  const colorterm = env.COLORTERM;
  if (env.FORCE_COLOR === "3" || colorterm === "truecolor" || colorterm === "24bit") return 24;
  if (env.FORCE_COLOR === "2" || (env.TERM ?? "").includes("256color")) return 8;
  return 1;
}

// For rendering that has no terminal behind it at all — unit tests, --json, file redirection.
export const plainTheme: Theme = {
  colour: false,
  unicode: false,
  depth: 1,
  c: PLAIN,
  s: ASCII_SYMBOLS,
  i: NO_ICONS,
};
