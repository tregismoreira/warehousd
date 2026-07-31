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
};

export type Symbols = {
  ok: string;
  fail: string;
  warn: string;
  pending: string;
  ellipsis: string;
};

export type Theme = {
  colour: boolean;
  unicode: boolean;
  c: Palette;
  s: Symbols;
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
};

// `createColors(true)` rather than picocolors' default export. The default runs its own TTY and
// NO_COLOR detection once, at import, and returns identity functions when it decides against
// colour — which would quietly override every decision resolveTheme just made, and made this
// module untestable (a unit test has no TTY, so `colour: true` still produced plain strings).
// Detection belongs in resolveTheme; this is only the escape codes.
const forced = pc.createColors(true);

const COLOUR: Palette = {
  bold: (s) => forced.bold(s),
  dim: (s) => forced.dim(s),
  red: (s) => forced.red(s),
  green: (s) => forced.green(s),
  yellow: (s) => forced.yellow(s),
  cyan: (s) => forced.cyan(s),
};

const UNICODE_SYMBOLS: Symbols = {
  ok: "✓",
  fail: "✗",
  warn: "!",
  pending: "·",
  ellipsis: "…",
};

const ASCII_SYMBOLS: Symbols = {
  ok: "ok",
  fail: "x",
  warn: "!",
  pending: "-",
  ellipsis: "...",
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

  return {
    colour,
    unicode,
    c: colour ? COLOUR : PLAIN,
    s: unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS,
  };
}

// For rendering that has no terminal behind it at all — unit tests, --json, file redirection.
export const plainTheme: Theme = {
  colour: false,
  unicode: false,
  c: PLAIN,
  s: ASCII_SYMBOLS,
};
