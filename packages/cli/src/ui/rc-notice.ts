import type { Theme } from "./theme";

// The one line every invocation opens with. It used to be said twice — once after `init`, once in
// the `start` summary — which left every other command silent: someone could run `status`, `apply`,
// `logs` and `deploy` for a week without being told what they were running. Both of those are gone
// now and this is the only copy.
//
// It names no version on purpose. A sentence with `0.1.0-rc.1` in it is a sentence that goes stale
// at the next release candidate, and nobody remembers to edit a string they never see fail.

const NOTICE =
  "This is a release candidate, and is not meant to be used in production. Read more at https://github.com/tregismoreira/warehousd";

/** Semver says a prerelease is anything with a `-` in it, and that is the whole test we need. */
export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

/**
 * The notice, dimmed for whatever terminal is behind it, or `null` once the shipped version is
 * stable — so the line removes itself at 1.0 rather than waiting for someone to notice it.
 *
 * The caller writes this to **stderr**, before commander parses argv. stdout is the product:
 * `status --json | jq` and `start 2>/dev/null` both have to keep working.
 */
export function rcNotice(version: string, theme: Theme): string | null {
  if (!isPrerelease(version)) return null;
  return theme.c.dim(NOTICE);
}
