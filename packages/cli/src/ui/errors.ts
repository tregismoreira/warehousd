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

export type Explained = {
  title: string;
  hint?: string | undefined;
};

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

export function explain(err: unknown): Explained {
  const raw = err instanceof Error ? err.message : String(err);
  for (const rule of RULES) {
    const m = raw.match(rule.match);
    if (m) return rule.explain(m, raw);
  }
  return { title: raw.trim() };
}

/** Matches the two-space indent every panel, progress line and notice in the CLI already uses. */
const INDENT = "  ";
/** Continuation lines align under the text, not under the glyph. */
const CONTINUATION = "    ";

/**
 * The failure, shaped like everything else the CLI prints.
 *
 * It used to be returned flush at column 0, so a failure landed hard against the
 * release-candidate notice above it and lined up with none of the output around it — a
 * one-line "No warehousd.yml in /path" read as though the terminal had emitted it rather
 * than warehousd.
 *
 * The glyph and the indent are the whole change; the words are still whatever `explain`
 * decided, including the driver's own where nothing matched. Blank lines around the block
 * belong to the caller.
 */
export function formatExplained(e: Explained, theme: Theme = plainTheme): string {
  const title = e.title.split("\n");
  const lines = title.map((line, i) =>
    i === 0 ? `${INDENT}${theme.c.red(theme.s.fail)} ${line}` : `${CONTINUATION}${line}`,
  );
  if (e.hint) {
    lines.push("");
    for (const line of e.hint.split("\n")) lines.push(`${CONTINUATION}${theme.c.dim(line)}`);
  }
  return lines.join("\n");
}
