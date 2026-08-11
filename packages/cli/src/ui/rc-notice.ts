import type { Theme } from "./theme";

// The one line every invocation opens with. It used to be said twice — once after `init`, once in
// the `start` summary — which left every other command silent: someone could run `status`, `apply`,
// `logs` and `deploy` for a week without being told what they were running. Both of those are gone
// now and this is the only copy.
//
// It names no version on purpose. A sentence with `0.1.0-rc.1` in it is a sentence that goes stale
// at the next release candidate, and nobody remembers to edit a string they never see fail.

/**
 * Two lines rather than one.
 *
 * As a single sentence it ran past 120 characters and wrapped wherever the terminal happened to
 * be, which put the URL in a different place on every machine. Breaking it at the sentence keeps
 * the warning and the link each on a line of their own, and both well inside 80 columns.
 */
const WARNING = "This is a release candidate, and is not meant to be used in production.";
const READ_MORE = "Read more at https://github.com/tregismoreira/warehousd";

/** Matches the two-space indent every panel and progress line in the CLI already uses. */
const INDENT = "  ";

/** Semver says a prerelease is anything with a `-` in it, and that is the whole test we need. */
export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

/**
 * The notice, or `null` once the shipped version is stable — so it removes itself at 1.0 rather
 * than waiting for someone to notice it.
 *
 * Carries the warning glyph and the same two-space indent as everything else the CLI prints. It
 * used to sit flush at column 0 with nothing above it, so it collided with the shell prompt and
 * lined up with none of the output beneath it — it read as terminal noise rather than as the
 * warning it is.
 *
 * The blank lines around it belong to `rcNoticeBlock` below, which is what a caller should print.
 *
 * Written to **stderr**, before commander parses argv. stdout is the product: `status --json | jq`
 * and `start 2>/dev/null` both have to keep working.
 */
export function rcNotice(version: string, theme: Theme): string | null {
  if (!isPrerelease(version)) return null;
  // The continuation aligns under the text, not under the glyph, so the two read as one block.
  const continuation = " ".repeat(INDENT.length + theme.s.warn.length + 1);
  return [
    `${INDENT}${theme.c.yellow(theme.s.warn)} ${theme.c.dim(WARNING)}`,
    `${continuation}${theme.c.dim(READ_MORE)}`,
  ].join("\n");
}

/**
 * The notice as it is actually written, blank lines and all — or `null` on a stable release.
 *
 * One above and one below, in **every** case. It used to carry only the one above and rely on
 * whatever followed bringing its own top spacing, which a panel did and a bare result line did
 * not: a `status` with nothing running printed its answer hard against the warning. Owning both
 * here is what makes the rule assertable rather than a convention four call sites have to keep.
 */
export function rcNoticeBlock(version: string, theme: Theme): string | null {
  const notice = rcNotice(version, theme);
  return notice === null ? null : `\n${notice}\n\n`;
}
