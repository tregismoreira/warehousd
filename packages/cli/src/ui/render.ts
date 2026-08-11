import type { Theme } from "./theme";
import { maskSecret, maskUrlPassword } from "./mask";
import {
  displayWidth,
  labelled,
  link,
  nextSteps,
  pad,
  rail,
  railDone,
  railFail,
  type NextStep,
} from "./frame";

// Pure string building. Everything here takes a Theme and returns a string, so the whole visual
// surface of the CLI can be asserted in a unit test without a terminal, without ANSI, and without
// spawning anything.
//
// Every block hangs from the frame's rail (ui/frame.ts) on a terminal and falls back to the flat
// two-space indent off one, and **no block carries a blank line of its own at either end** — the
// same contract ui/brand.ts, ui/rc-notice.ts and ui/errors.ts already keep, and for the same
// reason: what sits above and below varies, and only the caller knows.

export type Field = { label: string; value: string; secret?: boolean };
export type Section = { title?: string | undefined; fields: Field[] };

/** A titled section's fields step in under their heading, as they did before the rail. */
const SUB_INDENT = "   ";

function renderField(f: Field, width: number, theme: Theme, showSecrets: boolean, indent: string) {
  const shown = f.secret && !showSecrets ? maskSecret(f.value, theme.unicode) : f.value;
  return `${indent}${theme.c.dim(pad(f.label, width))}  ${link(shown, theme)}`;
}

/**
 * The label/value lists a panel is made of, as unprefixed lines for `rail` to hang.
 *
 * Sections are separated by a blank line, and an empty one is skipped rather than printed as a
 * bare heading.
 */
export function fieldLines(sections: Section[], theme: Theme, showSecrets = false): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    if (section.fields.length === 0) continue;
    if (lines.length > 0) lines.push("");
    const indent = section.title ? SUB_INDENT : "";
    if (section.title) lines.push(section.title);
    // Labels align within their own section rather than across the whole panel, so one long
    // label in one group does not push every other group's values off to the right.
    const width = Math.max(...section.fields.map((f) => displayWidth(f.label)));
    for (const f of section.fields) lines.push(renderField(f, width, theme, showSecrets, indent));
  }
  return lines;
}

/** A field list on the rail, with no headline of its own — what `secrets` prints. */
export function renderFields(opts: {
  sections: Section[];
  theme: Theme;
  showSecrets?: boolean | undefined;
  footer?: string[] | undefined;
}): string {
  const lines = fieldLines(opts.sections, opts.theme, opts.showSecrets ?? false);
  if (opts.footer?.length) lines.push("", ...opts.footer.map((l) => opts.theme.c.dim(l)));
  return rail(lines, opts.theme);
}

/**
 * "This finished, and here is what it did." One shape, for every command that has one.
 *
 * The headline sits in the glyph column behind a `◇`, and everything under it hangs from the rail.
 * Commands used to end however their author felt on the day — `init` on a dim `Next: warehousd
 * start` that read like narration, `apply` on the bare word `applied`, `stop` on a progress line
 * that had already scrolled — so nothing looked like completion and `init` in particular left
 * people unsure it had run.
 *
 * `sections` is optional: a command with nothing to report is a headline on its own, which is
 * still a great deal clearer than a lowercase verb.
 */
export function renderSuccess(opts: {
  headline: string;
  subtitle?: string | undefined;
  sections?: Section[] | undefined;
  theme: Theme;
  showSecrets?: boolean | undefined;
  footer?: string[] | undefined;
}): string {
  const { theme } = opts;
  const heading = opts.subtitle
    ? `${theme.c.bold(opts.headline)}   ${theme.c.dim(opts.subtitle)}`
    : theme.c.bold(opts.headline);
  const body = fieldLines(opts.sections ?? [], theme, opts.showSecrets ?? false);
  // A footer of several lines used to indent only its first, and the deploy summary now carries
  // what an operator still has to do.
  if (opts.footer?.length) body.push("", ...opts.footer.map((l) => theme.c.dim(l)));
  return [railDone([heading], theme), ...(body.length ? [rail(["", ...body], theme)] : [])].join(
    "\n",
  );
}

/** The docs link, which every big moment ends on. One URL, named in one place. */
export const DOCS_URL = "https://github.com/tregismoreira/warehousd";

/** The `└` line `start`, `restart` and `deploy` close on. */
export function docsOutro(theme: Theme): string {
  return `${labelled(theme.i.docs, "Docs and guides:")} ${theme.c.cyan(DOCS_URL)}`;
}

const START_NEXT_STEPS: NextStep[] = [
  { command: "warehousd open", says: "open the admin UI in a browser" },
  {
    command: "warehousd import run <collection> <file>",
    says: "load a spreadsheet into a collection",
  },
  { command: "warehousd seed", says: "fill it with synthetic data instead" },
];

const EVERYDAY_COMMANDS: NextStep[] = [
  { command: "warehousd status", says: "is it up, and on which URLs" },
  { command: "warehousd logs -f", says: "follow the server logs" },
  { command: "warehousd stop", says: "stop the containers, keeping your data" },
];

/**
 * The `start` summary — the moment the whole command exists for.
 *
 * It used to end on the panel and nothing else, so somebody watching their first stack come up was
 * given six URLs and no second command. What follows the panel is the onboarding this design is
 * for: what to do next, what to run every day, and how the credentials get back.
 *
 * `databaseUrl` goes through the URL masker rather than being flagged a secret outright: the host,
 * port and database name are the useful part and only the password needs hiding.
 */
export function renderStartSummary(opts: {
  outputs: {
    mcpUrl: string;
    apiUrl: string;
    adminUrl: string;
    databaseUrl: string;
    env: string;
    devClient: { clientId: string; clientSecret: string };
  };
  admin?: { email: string; password: string } | undefined;
  theme: Theme;
  showSecrets?: boolean | undefined;
  elapsed?: string | undefined;
}): string {
  const { outputs, theme } = opts;
  const showSecrets = opts.showSecrets ?? false;
  const i = theme.i;

  const sections: Section[] = [
    {
      fields: [
        { label: labelled(i.admin, "Admin UI"), value: outputs.adminUrl },
        { label: labelled(i.api, "API"), value: outputs.apiUrl },
        { label: labelled(i.mcp, "MCP"), value: outputs.mcpUrl },
        {
          label: labelled(i.database, "Database"),
          value: showSecrets
            ? outputs.databaseUrl
            : maskUrlPassword(outputs.databaseUrl, theme.unicode),
        },
        { label: labelled(i.env, "Env"), value: outputs.env },
      ],
    },
  ];

  if (opts.admin) {
    sections.push({
      title: labelled(i.login, "Admin login"),
      fields: [
        { label: "Email", value: opts.admin.email },
        { label: "Password", value: opts.admin.password, secret: true },
      ],
    });
  }

  sections.push({
    title: labelled(i.secrets, "Dev client"),
    fields: [
      { label: "ID", value: outputs.devClient.clientId },
      { label: "Secret", value: outputs.devClient.clientSecret, secret: true },
    ],
  });

  // The release-candidate line used to live here too. It is said once now, on stderr, at the top of
  // every invocation (src/ui/rc-notice.ts) — repeating it in the panel a few lines later only
  // taught people to skip both.
  const footer = [
    "",
    ...nextSteps("Next steps", START_NEXT_STEPS, theme),
    "",
    ...nextSteps("Everyday commands", EVERYDAY_COMMANDS, theme),
    ...(showSecrets
      ? []
      : ["", theme.c.dim("Secrets are masked — `warehousd secrets --show` reveals them.")]),
  ];

  return [
    renderSuccess({
      headline: labelled(i.running, "Your data layer is running"),
      sections,
      theme,
      showSecrets,
      ...(opts.elapsed === undefined ? {} : { subtitle: opts.elapsed }),
    }),
    rail(footer, theme),
  ].join("\n");
}

/**
 * `target` is passed in rather than known here.
 *
 * This module renders; it does not know where a deployment went. It used to: the heading read
 * "warehousd deployed to Fly" and a managed database was reported as `fly postgres connect`, on
 * every target, so a Compose deploy would have named a target it had not deployed to twice in five
 * lines.
 */
export function renderDeploySummary(opts: {
  outputs: {
    mcpUrl: string;
    apiUrl: string;
    adminUrl: string;
    databaseUrl: string | null;
    env: string;
  };
  target: { label: string; databaseHint: string; notes?: string[] | undefined };
  admin?: { email: string; password: string } | undefined;
  theme: Theme;
  showSecrets?: boolean | undefined;
}): string {
  const { outputs, theme } = opts;
  const showSecrets = opts.showSecrets ?? false;
  const i = theme.i;

  const fields: Field[] = [
    { label: labelled(i.admin, "Admin UI"), value: outputs.adminUrl },
    { label: labelled(i.api, "API"), value: outputs.apiUrl },
    { label: labelled(i.mcp, "MCP"), value: outputs.mcpUrl },
    {
      label: labelled(i.database, "Database"),
      value: outputs.databaseUrl
        ? showSecrets
          ? outputs.databaseUrl
          : maskUrlPassword(outputs.databaseUrl, theme.unicode)
        : opts.target.databaseHint,
    },
    { label: labelled(i.env, "Env"), value: outputs.env },
  ];

  const sections: Section[] = [{ fields }];
  if (opts.admin) {
    sections.push({
      title: labelled(i.login, "Admin login"),
      fields: [
        { label: "Email", value: opts.admin.email },
        { label: "Password", value: opts.admin.password, secret: true },
      ],
    });
  }

  // The notes come first: they are what is still to be done, and the masking line is a standing
  // remark about the panel above it.
  const notes = opts.target.notes ?? [];
  const footer = [
    ...(notes.length ? ["Still to do", ...notes] : []),
    ...(showSecrets ? [] : ["Secrets are masked — `warehousd secrets --show` reveals them."]),
  ];

  return renderSuccess({
    headline: labelled(i.running, `warehousd is live on ${opts.target.label}`),
    sections,
    theme,
    showSecrets,
    ...(footer.length ? { footer } : {}),
  });
}

// Shared by `doctor` and by `deploy`'s preflight, which already spoke in `{ id, ok, detail }`
// before this module existed (packages/cli/src/deploy/preflight.ts).
export type Check = { id: string; ok: boolean; detail: string };

export function renderChecks(checks: Check[], theme: Theme): string {
  if (checks.length === 0) return "";
  const width = Math.max(...checks.map((c) => displayWidth(c.id)));
  return checks
    .map((c) => {
      const mark = c.ok ? theme.c.accent(theme.s.done) : theme.c.red(theme.s.fail);
      const body = `${pad(c.id, width)}  ${theme.c.dim(c.detail)}`;
      return theme.unicode ? `${mark}  ${body}` : `  ${mark} ${body}`;
    })
    .join("\n");
}

export function renderStatus(opts: {
  project: string;
  healthy: boolean;
  containers: { name: string; state: string }[];
  outputs: {
    mcpUrl: string;
    apiUrl: string;
    adminUrl: string;
    databaseUrl: string;
    env: string;
    devClient: { clientId: string; clientSecret: string };
  } | null;
  theme: Theme;
  showSecrets?: boolean | undefined;
}): string {
  const { theme } = opts;
  const i = theme.i;
  const headline = theme.c.bold(
    opts.healthy ? `${opts.project} is running` : `${opts.project} is not responding`,
  );

  const sections: Section[] = [
    {
      title: "Containers",
      fields: opts.containers.map((c) => ({ label: c.name, value: c.state })),
    },
  ];

  if (opts.outputs) {
    sections.push({
      fields: [
        { label: labelled(i.admin, "Admin UI"), value: opts.outputs.adminUrl },
        { label: labelled(i.api, "API"), value: opts.outputs.apiUrl },
        { label: labelled(i.mcp, "MCP"), value: opts.outputs.mcpUrl },
        {
          label: labelled(i.database, "Database"),
          value: opts.showSecrets
            ? opts.outputs.databaseUrl
            : maskUrlPassword(opts.outputs.databaseUrl, theme.unicode),
        },
        { label: labelled(i.env, "Env"), value: opts.outputs.env },
      ],
    });
  }

  const body = fieldLines(sections, theme, opts.showSecrets ?? false);
  const head = opts.healthy ? railDone([headline], theme) : railFail([headline], theme);
  return [head, ...(body.length ? [rail(["", ...body], theme)] : [])].join("\n");
}

/** The `Next steps` block `init` ends on, before its own outro. */
export function initNextSteps(theme: Theme): string[] {
  return nextSteps(
    "Next steps",
    [
      { command: "warehousd start", says: "start the server and database on this machine" },
      { command: "warehousd open", says: "open the admin UI once it is running" },
    ],
    theme,
  );
}
