import type { Theme } from "./theme";
import { plainTheme } from "./theme";

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

export type Reporter = {
  step(verb: string, label: string): StepHandle;
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
// A fixed gutter, borrowed from cargo: the verb is right-aligned in its own column so the eye
// tracks a single edge down the page instead of re-finding the text on every line.
const GUTTER = 10;

function gutter(verb: string): string {
  return verb.length >= GUTTER ? verb : " ".repeat(GUTTER - verb.length) + verb;
}

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

  const line = (mark: string, verb: string, label: string, detail?: string) => {
    const tail = detail ? `  ${theme.c.dim(detail)}` : "";
    return `${mark}${theme.c.dim(gutter(verb))}  ${label}${tail}\n`;
  };

  return {
    step(verb: string, label: string): StepHandle {
      const started = now();
      let settled = false;
      // What `update()` last said, redrawn by every spinner frame so the detail does not blink
      // out between updates.
      let detail = "";
      let lastUpdate = 0;

      if (!quiet && isTTY) {
        let frame = 0;
        const paint = () => {
          const glyph = theme.unicode ? (FRAMES[frame % FRAMES.length] ?? "") : "";
          const tail = detail ? `  ${theme.c.dim(detail)}` : "";
          opts.writeErr(
            `\r\x1b[2K${theme.c.cyan(glyph)}${theme.c.dim(gutter(verb))}  ${label}${tail}`,
          );
          frame += 1;
        };
        paint();
        timer = setInterval(paint, SPINNER_INTERVAL_MS);
        // Never hold the event loop open for a spinner; the work decides when the process ends.
        timer.unref?.();
      }

      const settle = (ok: boolean, detail?: string) => {
        if (settled) return;
        settled = true;
        stopSpinner();
        if (quiet && ok) return;
        const elapsed = formatElapsed(now() - started);
        const mark = ok ? theme.c.green(theme.s.ok) : theme.c.red(theme.s.fail);
        const suffix = detail ? `${detail} · ${elapsed}` : elapsed;
        opts.writeErr(line(`${mark} `, verb, label, suffix));
      };

      return {
        update: (next: string) => {
          // Nothing to draw into off a TTY, and nothing that should be written instead: see the
          // rules on StepHandle.update.
          if (settled || quiet || !isTTY) return;
          const t = now();
          if (t - lastUpdate < UPDATE_INTERVAL_MS) return;
          lastUpdate = t;
          detail = next;
          const glyph = theme.unicode ? (FRAMES[0] ?? "") : "";
          opts.writeErr(
            `\r\x1b[2K${theme.c.cyan(glyph)}${theme.c.dim(gutter(verb))}  ${label}  ${theme.c.dim(detail)}`,
          );
        },
        done: (d?: string) => settle(true, d),
        fail: (d?: string) => settle(false, d),
      };
    },

    note(msg: string) {
      if (quiet) return;
      opts.writeErr(`${" ".repeat(GUTTER + 3)}${theme.c.dim(msg)}\n`);
    },

    warn(msg: string) {
      if (quiet) return;
      opts.writeErr(`${theme.c.yellow(theme.s.warn)} ${theme.c.dim(gutter("warning"))}  ${msg}\n`);
    },

    fail(msg: string) {
      stopSpinner();
      opts.writeErr(`${theme.c.red(theme.s.fail)} ${theme.c.dim(gutter("error"))}  ${msg}\n`);
    },

    out(msg: string) {
      opts.writeOut(msg.endsWith("\n") ? msg : `${msg}\n`);
    },
  };
}

// The default for every `runX` signature, so adding progress to an orchestration function does
// not change what its existing callers or tests have to pass.
export const silentReporter: Reporter = {
  step: () => ({ update: () => {}, done: () => {}, fail: () => {} }),
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
