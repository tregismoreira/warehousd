import type { Theme } from "./theme";
import { cmd, pad, displayWidth } from "./frame";
import { DOCS_URL } from "./render";

// The screen a bare `warehousd` and `warehousd --help` print.
//
// Commander's default is every command in alphabetical order followed by every global flag, which
// answers "what exists" and not "what do I type first" — and alphabetical puts `apply`, a command
// nobody runs on their first day, above `init`. Both references this design was grounded in say
// the same thing: common things first (clig.dev), and examples of real usage (12-factor CLI #1).
//
// So: four groups in the order somebody meets them, one line each, and three worked examples.
// Global flags are deliberately absent — `--json`, `--quiet`, `--no-color` and `--verbose` are
// noise on a discovery screen and every per-command `--help` still lists them.
//
// Pure, like the rest of `ui/`: a Theme in, a string out. Nothing here reads `process`.

const BLURB = [
  "warehousd — all your documents and datasets in one place,",
  "safely queryable by AI assistants.",
];

type Group = { title: string; commands: [name: string, says: string][] };

const GROUPS: Group[] = [
  {
    title: "Start here",
    commands: [
      ["init", "set up a warehousd project in this directory"],
      ["start", "start the server and its database, then print the URLs"],
      ["open", "open the admin UI (or mcp|api) in a browser"],
    ],
  },
  {
    title: "Work with data",
    commands: [
      ["import", "map a spreadsheet onto a collection, validate it, load it"],
      ["seed", "regenerate synthetic data, then re-index file collections"],
      ["index", "re-index a file collection"],
      ["embed", "fill embeddings for file collections (resumable)"],
    ],
  },
  {
    title: "Change the schema",
    commands: [
      ["apply", "apply config changes to a running stack, without a restart"],
      ["migrate", "plan and write migrations for destructive changes"],
    ],
  },
  {
    title: "Run it",
    commands: [
      ["status", "is this project's stack up, and on which URLs"],
      ["logs", "container logs — the answer to most 'it started but nothing works'"],
      ["stop", "stop the containers, keeping your data"],
      ["restart", "stop, then start again"],
      ["doctor", "check Docker, image, ports and config before anything breaks"],
      ["secrets", "show the generated credentials, masked unless --show"],
      ["deploy", "deploy this project to the target in warehousd.yml"],
    ],
  },
];

const EXAMPLES: [command: string, says: string][] = [
  ["warehousd init", "set up a new project, guided"],
  ["warehousd start", "bring it up on this machine"],
  ["warehousd import run products data.csv", "load a spreadsheet"],
];

const INDENT = "  ";
const ITEM = "    ";

export function helpScreen(theme: Theme): string {
  const lines: string[] = [];

  for (const line of BLURB) lines.push(`${INDENT}${line}`);
  lines.push("", `${INDENT}Usage`, `${ITEM}${cmd("warehousd <command> [options]", theme)}`);

  // One column for every group, not one per group: a name that lines up across the whole screen
  // is a name the eye can scan down, which is the entire point of grouping in the first place.
  const width = Math.max(...GROUPS.flatMap((g) => g.commands.map(([n]) => n.length)));
  for (const group of GROUPS) {
    lines.push("", `${INDENT}${group.title}`);
    for (const [name, says] of group.commands) {
      lines.push(`${ITEM}${cmd(pad(name, width), theme)}  ${theme.c.dim(says)}`);
    }
  }

  const exampleWidth = Math.max(...EXAMPLES.map(([c]) => displayWidth(c)));
  lines.push("", `${INDENT}Examples`);
  for (const [command, says] of EXAMPLES) {
    lines.push(`${ITEM}${cmd(pad(command, exampleWidth), theme)}  ${theme.c.dim(says)}`);
  }

  lines.push(
    "",
    `${INDENT}${theme.c.dim("warehousd <command> --help shows every option.")}`,
    `${INDENT}${theme.c.dim("Docs:")} ${theme.c.cyan(DOCS_URL)}`,
  );

  return lines.join("\n");
}
