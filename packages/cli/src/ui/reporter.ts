import type { Theme } from "./theme";
import { plainTheme } from "./theme";
import { railLine, railWarn, railFail } from "./frame";

// Progress narration, and the one place in the UI layer that holds state.
//
// Two rules shape it. First, `write` is injected, so a test captures output without a terminal,
// without ANSI and without waiting on a timer. Second, narration goes to **stderr** and the
// product — the outputs panel, anything under --json — goes to **stdout**. That split is what
// makes `warehousd start --json | jq` work and what lets `warehousd start 2>/dev/null` show the
// summary alone.
//
// Off a TTY there is no animation and no cursor movement at all: one plain line per completed
// step. The e2e suite drives this binary through `execFileSync` with `stdio: "pipe"`, and a
// spinner writing escape codes into that pipe would be both useless and unassertable.

export type StepHandle = {
  /**
   * Move a live step forward. Draws into the spinner line; never emits a line of its own.
   *
   * Three rules, all of them consequences of the two above:
   *
   *   - **Off a TTY it does nothing at all.** The e2e suite drives this binary through
   *     `execFileSync` with `stdio: "pipe"`, and a step emitting ten thousand progress lines into
   *     that pipe would break every assertion in it. The completed step still prints its one
   *     plain line.
   *   - **Throttled by wall clock, not by item.** One write per row would make an import slower
   *     than the import; ~10/second is past the eye's ability to read anyway.
   *   - **stderr.** It must never reach stdout, or `warehousd start --json | jq` stops being
   *     machine-readable.
   */
  update(detail: string): void;
  /**
   * The same, for work that knows how far along it is: draws the `█░` bar rather than a count.
   *
   * Determinate work is the case where a spinner is actively unhelpful — an image pull, an import,
   * an embedding run all know their total, and "52%" answers the question the spinner cannot.
   * Every rule above applies unchanged, off-TTY silence included: a bar redrawn into a CI log ten
   * times a second is the Christmas tree this design exists to avoid.
   */
  progress(done: number, total: number, label?: string): void;
  done(detail?: string): void;
  fail(detail?: string): void;
};

/**
 * How far along a long operation is, in the shape `EmbedProgress` already had.
 *
 * One convention rather than five: every broker operation that can report progress reports it
 * like this, so `progressDetail` below is the only thing that has to know how to phrase it.
 * `total` is optional because two of the five genuinely cannot know it up front — an indexer is
 * walking a directory, an apply is working through a list it builds as it goes.
 */
export type Progress = { done: number; total?: number | undefined; label?: string | undefined };

// "1,240 / 6,351 · 38s · ~2m left". The ETA is linear from the rate so far, which is the honest
// estimate for work that is uniform per item — and every one of these is.
export function progressDetail(p: Progress, elapsedMs: number): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const head = p.total === undefined || p.total <= 0 ? n(p.done) : `${n(p.done)} / ${n(p.total)}`;
  const parts = [head, formatElapsed(elapsedMs)];
  if (p.total !== undefined && p.total > 0 && p.done > 0 && p.done < p.total) {
    const remaining = ((p.total - p.done) * elapsedMs) / p.done;
    parts.push(`~${formatElapsed(remaining)} left`);
  }
  if (p.label) parts.push(p.label);
  return parts.join(" · ");
}

/** How wide the determinate bar is drawn. Twenty cells reads as a bar and fits a narrow terminal. */
const BAR_CELLS = 20;

/** `██████████░░░░░░░░░░  52%`. Pure, so the shape can be asserted without a terminal. */
export function progressBar(done: number, total: number, theme: Theme): string {
  if (!theme.unicode || total <= 0) {
    return `${Math.min(100, Math.max(0, Math.round((done / Math.max(total, 1)) * 100)))}%`;
  }
  const ratio = Math.min(1, Math.max(0, done / total));
  const filled = Math.round(ratio * BAR_CELLS);
  const bar = `${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}`;
  return `${theme.c.accent(bar)}  ${Math.round(ratio * 100)}%`;
}

export type Reporter = {
  /**
   * How many steps this command is about to take, so each one can say where it is.
   *
   * "Creating supabase project" tells you what is happening; "[4/9] Creating supabase project"
   * tells you whether to go and make coffee. It matters most on the two long commands — `init`
   * with a provider to set up, and `deploy` — where the alternative is a page of lines with no
   * sense of an end.
   *
   * A count rather than a list of labels: the labels are already at the call sites, and a second
   * copy here would be a second thing to keep in step. Calling it again resets the counter, which
   * is what a command with two phases wants.
   */
  plan(total: number): void;
  /**
   * `verb` and `label` are joined into one sentence now rather than sitting in a right-aligned
   * gutter — "Checking Docker" reads, "  Checking  Docker" only aligned.
   *
   * `settled` is the same sentence in the past tense, for the line that survives on screen:
   * a step that is still running says "Pulling …" and the one that finished says "Pulled …".
   * Omitted, the live wording stays.
   */
  step(verb: string, label: string, settled?: string): StepHandle;
  note(msg: string): void;
  warn(msg: string): void;
  fail(msg: string): void;
  /** stdout — the thing a pipe is after. */
  out(msg: string): void;
};

export type ReporterOptions = {
  writeErr: (s: string) => void;
  writeOut: (s: string) => void;
  theme?: Theme | undefined;
  isTTY?: boolean | undefined;
  quiet?: boolean | undefined;
  now?: (() => number) | undefined;
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
// The floor between two `update()` writes. One write per row would make the import slower than the
// import; ten a second is already past what anyone reads.
const UPDATE_INTERVAL_MS = 100;

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function createReporter(opts: ReporterOptions): Reporter {
  const theme = opts.theme ?? plainTheme;
  const isTTY = opts.isTTY ?? false;
  const quiet = opts.quiet ?? false;
  const now = opts.now ?? (() => Date.now());

  // Only one step is ever live, so one timer handle is enough.
  let timer: NodeJS.Timeout | null = null;

  // The step counter. Zero total means "no plan was declared", which is every command that has
  // not opted in — and those must look exactly as they did before.
  let plannedTotal = 0;
  let stepNumber = 0;

  const clearLine = () => {
    if (isTTY) opts.writeErr("\r\x1b[2K");
  };

  const stopSpinner = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearLine();
  };

  /**
   * A step line: the glyph sits in the rail's own column, so a finished step, a failure and the
   * rail all line up down the page and the frame stays unbroken.
   */
  const line = (mark: string, body: string): string =>
    theme.unicode ? `${mark}  ${body}` : `  ${mark} ${body}`;

  /**
   * `[3/9] ` when a plan was declared, nothing otherwise.
   *
   * Padded to the width of the total so the sentences stay on one column.
   */
  const counter = (n: number): string => {
    if (plannedTotal <= 0) return "";
    const width = String(plannedTotal).length;
    return theme.c.dim(`[${String(n).padStart(width)}/${plannedTotal}]  `);
  };

  return {
    plan(total: number): void {
      plannedTotal = total;
      stepNumber = 0;
    },

    step(verb: string, label: string, settled?: string): StepHandle {
      const started = now();
      let done = false;
      stepNumber += 1;
      const prefix = counter(stepNumber);
      const live = `${prefix}${[verb, label].filter(Boolean).join(" ")}`;
      const finished = `${prefix}${settled ?? [verb, label].filter(Boolean).join(" ")}`;
      // What `update()` last said, redrawn by every spinner frame so the detail does not blink
      // out between updates.
      let detail = "";
      let lastUpdate = 0;

      const paintLive = (glyphIndex: number) => {
        const glyph = theme.unicode ? (FRAMES[glyphIndex % FRAMES.length] ?? "") : "";
        const tail = detail ? `  ${detail}` : "";
        opts.writeErr(`\r\x1b[2K${theme.c.cyan(glyph)}  ${live}${tail}`);
      };

      if (!quiet && isTTY) {
        let frame = 0;
        const paint = () => {
          paintLive(frame);
          frame += 1;
        };
        paint();
        timer = setInterval(paint, SPINNER_INTERVAL_MS);
        // Never hold the event loop open for a spinner; the work decides when the process ends.
        timer.unref?.();
      }

      const settle = (ok: boolean, tail?: string) => {
        if (done) return;
        done = true;
        stopSpinner();
        if (quiet && ok) return;
        const elapsed = theme.c.dim(` · ${formatElapsed(now() - started)}`);
        const mark = ok ? theme.c.accent(theme.s.done) : theme.c.red(theme.s.fail);
        const body = tail ? `${finished} — ${theme.c.dim(tail)}` : finished;
        opts.writeErr(`${line(mark, `${body}${elapsed}`)}\n`);
      };

      const draw = (next: string) => {
        // Nothing to draw into off a TTY, and nothing that should be written instead: see the
        // rules on StepHandle.update.
        if (done || quiet || !isTTY) return;
        const t = now();
        if (t - lastUpdate < UPDATE_INTERVAL_MS) return;
        lastUpdate = t;
        detail = next;
        paintLive(0);
      };

      return {
        update: (next: string) => draw(theme.c.dim(next)),
        progress: (n: number, total: number, label?: string) => {
          const tail = [formatElapsed(now() - started), ...(label ? [label] : [])].join(" · ");
          draw(`${progressBar(n, total, theme)}${theme.c.dim(` · ${tail}`)}`);
        },
        done: (d?: string) => settle(true, d),
        fail: (d?: string) => settle(false, d),
      };
    },

    note(msg: string) {
      if (quiet) return;
      opts.writeErr(`${railLine(theme.c.dim(msg), theme)}\n`);
    },

    warn(msg: string) {
      if (quiet) return;
      opts.writeErr(`${railWarn([msg], theme)}\n`);
    },

    fail(msg: string) {
      stopSpinner();
      opts.writeErr(`${railFail([msg], theme)}\n`);
    },

    out(msg: string) {
      opts.writeOut(msg.endsWith("\n") ? msg : `${msg}\n`);
    },
  };
}

// The default for every `runX` signature, so adding progress to an orchestration function does
// not change what its existing callers or tests have to pass.
export const silentReporter: Reporter = {
  plan: () => {},
  step: () => ({ update: () => {}, progress: () => {}, done: () => {}, fail: () => {} }),
  note: () => {},
  warn: () => {},
  fail: () => {},
  out: () => {},
};

export function createStdReporter(opts: {
  theme: Theme;
  isTTY: boolean;
  quiet?: boolean | undefined;
}): Reporter {
  return createReporter({
    writeErr: (s) => process.stderr.write(s),
    writeOut: (s) => process.stdout.write(s),
    theme: opts.theme,
    isTTY: opts.isTTY,
    quiet: opts.quiet,
  });
}
