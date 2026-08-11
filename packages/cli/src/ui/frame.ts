import type { Theme } from "./theme";

// The connected rail every human run of the CLI is drawn on.
//
// One frame per command: `┌  warehousd start` at the top, `│` down the left of everything it
// says, and `└  <what to do next>` at the bottom. The wizard already looked like this — it is
// @clack/prompts' own shape — and everything around it did not, so `init` read as two programs
// stapled together. Column 4 is clack's content column, so the two now line up exactly.
//
// Pure, like the rest of `ui/`: a Theme goes in, a string comes out, and nothing here reads
// `process`. **Off a terminal there is no frame and no rail at all** — `theme.unicode` is false
// for a pipe, and every helper below falls back to the flat two-space indent the CLI has always
// printed there. `packages/cli/test/e2e/lifecycle.e2e.test.ts` reads both streams through a pipe
// and a rail character in them would be decoration nobody asked for.

/** What the flat rendering indents by, and what the rail's own content column lines up with. */
const INDENT = "  ";

/** `┌  warehousd start`, or nothing at all where there is no rail to open. */
export function frameOpen(title: string, theme: Theme): string | null {
  if (!theme.unicode) return null;
  return `${theme.c.dim(theme.s.top)}  ${theme.c.bold(title)}`;
}

/**
 * `└  <one-line outro>`, or nothing at all where there is no rail to close.
 *
 * The outro is always a *what-next* sentence, never a status repeat: the status is the block
 * above it, and a failure in particular must not end on a bare stack of red.
 */
export function frameClose(outro: string, theme: Theme): string | null {
  if (!theme.unicode) return null;
  // Every outro is prose, and every outro names a command, so this is the one place the backticks
  // are guaranteed to be worth trading for colour.
  return `${theme.c.dim(theme.s.bottom)}  ${prose(outro, theme)}`;
}

/** One line on the rail. An empty string is the bare `│` spacer between blocks. */
export function railLine(line: string, theme: Theme): string {
  if (!theme.unicode) return line === "" ? "" : `${INDENT}${line}`;
  const bar = theme.c.dim(theme.s.bar);
  return line === "" ? bar : `${bar}  ${line}`;
}

/** A run of lines on the rail, in order. */
export function rail(lines: string[], theme: Theme): string {
  return lines.map((l) => railLine(l, theme)).join("\n");
}

/**
 * A block whose first line carries a glyph in the rail's own column, and whose continuations hang
 * from the rail — `▲  2 fields are closed by default. / │  Review warehousd.yml…`.
 *
 * The glyph replaces the rail rather than sitting beside it, which is what makes a warning or a
 * failure findable in a page of output without colour doing the work on its own.
 */
export function railMark(mark: string, lines: string[], theme: Theme): string {
  const [first, ...rest] = lines;
  const head = theme.unicode ? `${mark}  ${first ?? ""}` : `${INDENT}${mark} ${first ?? ""}`;
  return [head, ...rest.map((l) => railLine(l, theme))].join("\n");
}

/** The caution block: `▲` in yellow, its text with it. */
export function railWarn(lines: string[], theme: Theme): string {
  return railMark(theme.c.yellow(theme.s.warn), lines, theme);
}

/** The failure block: `■` in red. */
export function railFail(lines: string[], theme: Theme): string {
  return railMark(theme.c.red(theme.s.fail), lines, theme);
}

/** The done block: `◇` in the brand accent. */
export function railDone(lines: string[], theme: Theme): string {
  return railMark(theme.c.accent(theme.s.done), lines, theme);
}

/**
 * Somewhere you can go, in cyan — a URL or a file path the command wrote.
 *
 * Applied by looking at the value rather than by a flag at each call site, so a URL is the same
 * colour in `start`, `status`, `deploy` and `secrets` without four places having to remember.
 */
export function link(value: string, theme: Theme): string {
  return /^(https?|postgres(ql)?):\/\//.test(value) ? theme.c.cyan(value) : value;
}

/** Something you can type, in bold accent. The one colour that means "this is a command". */
export function cmd(text: string, theme: Theme): string {
  return theme.c.bold(theme.c.accent(text));
}

/**
 * A sentence with `backticked` commands in it, drawn with the colour doing the quoting.
 *
 * Markdown punctuation is a workaround for not having colour, and this output has colour: a
 * terminal that can print `warehousd start` in the type colour does not also need two grave
 * accents around it. They stay wherever colour is off — a pipe, `NO_COLOR`, `--no-color`,
 * `TERM=dumb` — because there the backtick is the only thing marking the span as something to type
 * rather than something to read.
 *
 * `rest` styles everything that is *not* a command, and it has to be applied per-segment rather
 * than to the finished line: `cmd` ends its span with SGR 22, which resets dim as well as bold, so
 * dimming the whole line first would leave every word after the first command undimmed.
 */
export function prose(text: string, theme: Theme, rest: (s: string) => string = (s) => s): string {
  if (!theme.colour) return rest(text);
  // `split` on a regex with one capture group alternates literal, captured, literal…
  return text
    .split(/`([^`]+)`/)
    .map((part, i) => (i % 2 === 1 ? cmd(part, theme) : rest(part)))
    .join("");
}

export type NextStep = { command: string; says: string };

/**
 * A `Next steps` / `Everyday commands` list: the command in the type colour, what it does beside
 * it, aligned on one column.
 *
 * clig.dev and Atlassian both land on the same rule — suggest the next best step, always — and
 * this is the shape it takes at the two moments (`start`, `deploy`) where somebody has just
 * arrived and has no idea what the second command is.
 */
export function nextSteps(title: string, steps: NextStep[], theme: Theme): string[] {
  if (steps.length === 0) return [];
  const width = Math.max(...steps.map((s) => displayWidth(s.command)));
  return [
    title,
    ...steps.map((s) => `${cmd(pad(s.command, width), theme)}  ${theme.c.dim(s.says)}`),
  ];
}

/**
 * How many terminal columns a string takes, which is not how many characters it has.
 *
 * An emoji occupies two cells and is two UTF-16 units, a variation selector occupies none and is
 * one, and `String.length` is wrong about both — which is enough to knock a whole column of
 * values out of line the moment one label carries an icon and its neighbour does not. Only the
 * ranges the icon set actually uses are treated as wide; nothing here is a general-purpose
 * grapheme measurer, and it does not need to be.
 */
export function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200d) continue; // variation selector, zero-width joiner
    n += isWide(cp) ? 2 : 1;
  }
  return n;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff)
  );
}

export function pad(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** A label with its concept icon, or just the label where icons are dropped. */
export function labelled(icon: string, label: string): string {
  return icon ? `${icon} ${label}` : label;
}

export type Frame = {
  /** A block on the rail, with the `│` spacer that separates it from whatever came before. */
  block(body: string): void;
  /** Close on a what-next sentence, and leave one blank line before the next shell prompt. */
  close(outro: string): void;
};

/**
 * One open frame, writing as it goes. The one impure export here, and it is the only one — every
 * decision about what a line *looks* like is still made by the pure helpers above.
 *
 * `--json` gets nothing at all: that stream is parsed. Off a terminal `frameOpen` returns null on
 * its own and every block falls back to the flat two-space indent the CLI has always printed into
 * a pipe, so this is very nearly a no-op there — which is the point.
 *
 * `--quiet` keeps the blocks and drops the two corners. It means "only errors and results": the
 * blocks are the result, and a greeting line plus a suggestion about what to run next are neither.
 *
 * `stream` is `out` for all but two commands. The frame is the *result*, so it belongs on stdout
 * beside the panels it wraps; `import map` and `logs` are the exceptions, because their product is
 * a YAML block and a log stream that a pipe is entitled to receive unaccompanied.
 */
export function openFrame(
  title: string,
  theme: Theme,
  opts: {
    json?: boolean | undefined;
    quiet?: boolean | undefined;
    stream?: "out" | "err" | undefined;
  } = {},
): Frame {
  const json = opts.json ?? false;
  const quiet = opts.quiet ?? false;
  const write = (s: string) => (opts.stream === "err" ? process.stderr : process.stdout).write(s);
  if (!json && !quiet && title !== "") {
    const top = frameOpen(title, theme);
    if (top) write(`${top}\n`);
  }
  return {
    block(body: string) {
      if (json || body === "") return;
      write(`${railLine("", theme)}\n${body}\n`);
    },
    close(outro: string) {
      if (json) return;
      const bottom = quiet ? null : frameClose(outro, theme);
      write(bottom === null ? "\n" : `${railLine("", theme)}\n${bottom}\n\n`);
    },
  };
}
