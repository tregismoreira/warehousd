// Turning a driver's words into ours.
//
// The incident this module exists for: a first `start` in examples/harbor printed five Docker
// daemon lines — every one of them the *success* path of a probe — and then failed on something
// else entirely. The real fault was that no `server.image` was set, so the image resolved to a
// registry tag that could not be pulled, while a perfectly good local image sat unused. Nothing
// in the output said which image was wanted or where the name came from.
//
// Anything not recognised here keeps its original text. Guessing wrong about an unfamiliar error
// is worse than passing it through: the reader can search for Docker's words, but not for ours.

import { plainTheme, type Theme } from "./theme";
import { frameClose, railFail } from "./frame";

export type Explained = {
  title: string;
  hint?: string | undefined;
  /**
   * True when no rule matched, so the words below are the driver's and not ours.
   *
   * The 12-factor CLI's fifth rule wants a description, a fix and a *reference*, and the reference
   * for an error nobody has written a rule for is the issue tracker: we cannot tell the user how
   * to fix something we did not recognise, but we can tell them who to tell.
   */
  unexpected?: boolean | undefined;
};

/** Where an error nobody anticipated should end up. */
export const ISSUES_URL = "https://github.com/tregismoreira/warehousd/issues";

type Rule = {
  match: RegExp;
  explain: (m: RegExpMatchArray, raw: string) => Explained;
};

const RULES: Rule[] = [
  {
    match: /port is already allocated|address already in use|bind for .* failed/i,
    explain: () => ({
      title: "That port is already in use.",
      hint: "Change `server.port` in warehousd.yml, or run `warehousd stop` in whichever project holds it.",
    }),
  },
  {
    match:
      /(pull access denied|manifest unknown|not found: manifest|repository does not exist|denied: requested access)/i,
    explain: (_m, raw) => ({
      title: `Could not pull the server image.\n${raw.trim()}`,
      hint: "Set `server.image` in warehousd.yml or WAREHOUSD_IMAGE to an image you have — e.g. one you built locally with `docker build -f apps/web/Dockerfile -t warehousd:dev .`",
    }),
  },
  {
    match: /cannot connect to the docker daemon|is the docker daemon running/i,
    explain: () => ({
      title: "Docker is installed but the daemon isn't reachable.",
      hint: "Start Docker Desktop (or `colima start`) and retry.",
    }),
  },
  {
    match: /no space left on device/i,
    explain: () => ({
      title: "Docker has run out of disk space.",
      hint: "Reclaim some with `docker system prune` — note that this removes unused images and volumes across every project on this machine.",
    }),
  },
  {
    match: /health check (?:failed|timeout)/i,
    explain: (_m, raw) => ({
      title: raw.trim(),
      hint: "The container started but never answered /api/health. `warehousd logs --tail 100` shows why; the usual causes are a SQL error applying the config or an unreachable database.",
    }),
  },
  {
    match: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i,
    explain: (_m, raw) => ({
      title: `Could not reach the database.\n${raw.trim()}`,
      hint: "Check `database.url` in warehousd.yml, or run `warehousd status` to see whether the stack is up.",
    }),
  },
];

/**
 * The four JavaScript errors that are always a bug in our own code, never a condition in the world.
 *
 * "No rule matched" is *not* the same as "unexpected". Most unmatched errors are warehousd's own
 * finished sentences — "No secrets yet…", "Unknown collection: x" — and telling the reader to open
 * an issue about one of those is both wrong and rude. These four are the ones nobody should ever
 * see, so these are the ones that get the tracker link.
 */
const BUGS = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError"]);

export function explain(err: unknown): Explained {
  const raw = err instanceof Error ? err.message : String(err);
  for (const rule of RULES) {
    const m = raw.match(rule.match);
    if (m) return rule.explain(m, raw);
  }
  if (err instanceof Error && BUGS.has(err.name)) {
    return {
      title: `Unexpected error — ${err.name}: ${raw.trim()}`,
      hint: "Re-run with --verbose for the stack trace.",
      unexpected: true,
    };
  }
  return { title: raw.trim() };
}

/**
 * The failure, shaped like everything else the CLI prints.
 *
 * It used to be returned flush at column 0, so a failure landed hard against the
 * release-candidate notice above it and lined up with none of the output around it — a
 * one-line "No warehousd.yml in /path" read as though the terminal had emitted it rather
 * than warehousd.
 *
 * The `■` takes the rail's own column and the hint hangs from the rail under it, so a failure is
 * part of the same frame as the steps that led to it rather than a separate thing printed
 * afterwards. The words are still whatever `explain` decided, including the driver's own where
 * nothing matched. Blank lines around the block belong to the caller.
 */
export function formatExplained(e: Explained, theme: Theme = plainTheme): string {
  const lines = e.title.split("\n");
  if (e.hint) for (const line of e.hint.split("\n")) lines.push(theme.c.dim(line));
  return railFail(lines, theme);
}

/**
 * The `└` a failed command closes on: what to do, never a repeat of what went wrong.
 *
 * clig.dev's rule and Atlassian's seventh — suggest the next best step, always. A run that ends on
 * a bare stack of red tells somebody they have a problem and leaves them there; this is the line
 * that says which way is out. For an error no rule recognised, the way out is the issue tracker.
 */
export function errorOutro(e: Explained, command: string | null, theme: Theme): string | null {
  const next = e.unexpected
    ? `If this keeps happening, report it: ${theme.c.cyan(ISSUES_URL)}`
    : command
      ? `Fix the problem above, then re-run \`warehousd ${command}\`.`
      : "Fix the problem above, then try again.";
  return frameClose(next, theme);
}
