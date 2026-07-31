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
  done(detail?: string): void;
  fail(detail?: string): void;
};

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

      if (!quiet && isTTY) {
        let frame = 0;
        const paint = () => {
          const glyph = theme.unicode ? (FRAMES[frame % FRAMES.length] ?? "") : "";
          opts.writeErr(`\r\x1b[2K${theme.c.cyan(glyph)}${theme.c.dim(gutter(verb))}  ${label}`);
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
        done: (detail?: string) => settle(true, detail),
        fail: (detail?: string) => settle(false, detail),
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
  step: () => ({ done: () => {}, fail: () => {} }),
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
