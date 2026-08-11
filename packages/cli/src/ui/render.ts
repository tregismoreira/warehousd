import type { Theme } from "./theme";
import { maskSecret, maskUrlPassword } from "./mask";

// Pure string building. Everything here takes a Theme and returns a string, so the whole visual
// surface of the CLI can be asserted in a unit test without a terminal, without ANSI, and without
// spawning anything. The old `═══` walls are gone: sixty box characters above and below cost two
// lines and told the reader nothing, while the fields themselves were left ragged.

export type Field = { label: string; value: string; secret?: boolean };
export type Section = { title?: string | undefined; fields: Field[] };

const INDENT = "  ";
const SUB_INDENT = "    ";

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function renderField(f: Field, width: number, theme: Theme, showSecrets: boolean, indent: string) {
  const shown = f.secret && !showSecrets ? maskSecret(f.value, theme.unicode) : f.value;
  return `${indent}${theme.c.dim(pad(f.label, width))}  ${shown}`;
}

export function renderPanel(opts: {
  title: string;
  subtitle?: string | undefined;
  sections: Section[];
  theme: Theme;
  showSecrets?: boolean | undefined;
  /** One line each. Wrapped text belongs in the caller, which knows what it is saying. */
  footer?: string[] | undefined;
}): string {
  const { theme } = opts;
  const showSecrets = opts.showSecrets ?? false;
  const lines: string[] = [""];

  const heading = theme.c.bold(opts.title);
  lines.push(
    opts.subtitle ? `${INDENT}${heading}  ${theme.c.dim(opts.subtitle)}` : `${INDENT}${heading}`,
  );

  for (const section of opts.sections) {
    if (section.fields.length === 0) continue;
    lines.push("");
    const indent = section.title ? SUB_INDENT : INDENT;
    if (section.title) lines.push(`${INDENT}${section.title}`);
    // Labels align within their own section rather than across the whole panel, so one long
    // label in one group does not push every other group's values off to the right.
    const width = Math.max(...section.fields.map((f) => f.label.length));
    for (const f of section.fields) {
      lines.push(renderField(f, width, theme, showSecrets, indent));
    }
  }

  // Indented per line rather than as one string: a footer of several lines used to align only its
  // first, and the deploy summary now carries what an operator still has to do.
  if (opts.footer && opts.footer.length > 0) {
    lines.push("");
    for (const line of opts.footer) lines.push(`${INDENT}${theme.c.dim(line)}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * "This finished, and here is what it did." One shape, for every command that has one.
 *
 * A wrapper over `renderPanel` rather than a second renderer, because the only thing a success
 * differs by is its heading: the accent glyph and the headline. Commands used to end however their
 * author felt on the day — `init` on a dim `Next: warehousd start` that read like narration,
 * `apply` on the bare word `applied`, `stop` on a progress line that had already scrolled — so
 * nothing looked like completion and `init` in particular left people unsure it had run.
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
  return renderPanel({
    title: `${theme.c.accent(theme.s.ok)} ${opts.headline}`,
    sections: opts.sections ?? [],
    theme,
    ...(opts.subtitle === undefined ? {} : { subtitle: opts.subtitle }),
    ...(opts.showSecrets === undefined ? {} : { showSecrets: opts.showSecrets }),
    ...(opts.footer === undefined ? {} : { footer: opts.footer }),
  });
}

// The `start` summary. `databaseUrl` is passed through the URL masker rather than flagged as a
// secret outright: the host, port and database name are the useful part and only the password
// needs hiding.
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

  const sections: Section[] = [
    {
      fields: [
        { label: "MCP", value: outputs.mcpUrl },
        { label: "API", value: outputs.apiUrl },
        { label: "Admin", value: outputs.adminUrl },
        {
          label: "Database",
          value: showSecrets
            ? outputs.databaseUrl
            : maskUrlPassword(outputs.databaseUrl, theme.unicode),
        },
        { label: "Env", value: outputs.env },
      ],
    },
    {
      title: "Dev client",
      fields: [
        { label: "ID", value: outputs.devClient.clientId },
        { label: "Secret", value: outputs.devClient.clientSecret, secret: true },
      ],
    },
  ];

  if (opts.admin) {
    sections.push({
      title: "Admin login",
      fields: [
        { label: "Email", value: opts.admin.email },
        { label: "Password", value: opts.admin.password, secret: true },
      ],
    });
  }

  // The release-candidate line used to live here too. It is said once now, on stderr, at the top of
  // every invocation (src/ui/rc-notice.ts) — repeating it in the panel a few lines later only
  // taught people to skip both.
  const footer = showSecrets ? [] : ["Secrets are masked — reveal with `warehousd secrets --show`"];

  return renderSuccess({
    headline: "warehousd is running",
    subtitle: opts.elapsed,
    sections,
    theme,
    showSecrets,
    footer,
  });
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

  const fields: Field[] = [
    { label: "MCP", value: outputs.mcpUrl },
    { label: "API", value: outputs.apiUrl },
    { label: "Admin", value: outputs.adminUrl },
    {
      label: "Database",
      value: outputs.databaseUrl
        ? showSecrets
          ? outputs.databaseUrl
          : maskUrlPassword(outputs.databaseUrl, theme.unicode)
        : opts.target.databaseHint,
    },
    { label: "Env", value: outputs.env },
  ];

  const sections: Section[] = [{ fields }];
  if (opts.admin) {
    sections.push({
      title: "Admin login",
      fields: [
        { label: "Email", value: opts.admin.email },
        { label: "Password", value: opts.admin.password, secret: true },
      ],
    });
  }

  // The notes come first: they are what is still to be done, and the masking line is a standing
  // remark about the panel above it.
  const footer = [
    ...(opts.target.notes ?? []),
    ...(showSecrets ? [] : ["Secrets are masked — reveal with `warehousd secrets --show`"]),
  ];

  return renderSuccess({
    headline: `warehousd deployed to ${opts.target.label}`,
    sections,
    theme,
    showSecrets,
    footer,
  });
}

// Shared by `doctor` and by `deploy`'s preflight, which already spoke in `{ id, ok, detail }`
// before this module existed (packages/cli/src/deploy/preflight.ts).
export type Check = { id: string; ok: boolean; detail: string };

export function renderChecks(checks: Check[], theme: Theme): string {
  if (checks.length === 0) return "";
  const width = Math.max(...checks.map((c) => c.id.length));
  const lines = checks.map((c) => {
    const mark = c.ok ? theme.c.green(theme.s.ok) : theme.c.red(theme.s.fail);
    return `${INDENT}${mark}  ${pad(c.id, width)}  ${theme.c.dim(c.detail)}`;
  });
  return lines.join("\n");
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
  const mark = opts.healthy ? theme.c.green(theme.s.ok) : theme.c.red(theme.s.fail);
  const state = opts.healthy ? "running" : "not responding";

  const sections: Section[] = [
    {
      title: "Containers",
      fields: opts.containers.map((c) => ({ label: c.name, value: c.state })),
    },
  ];

  if (opts.outputs) {
    sections.push({
      fields: [
        { label: "MCP", value: opts.outputs.mcpUrl },
        { label: "API", value: opts.outputs.apiUrl },
        { label: "Admin", value: opts.outputs.adminUrl },
        {
          label: "Database",
          value: opts.showSecrets
            ? opts.outputs.databaseUrl
            : maskUrlPassword(opts.outputs.databaseUrl, theme.unicode),
        },
        { label: "Env", value: opts.outputs.env },
      ],
    });
  }

  return renderPanel({
    title: `${mark} ${opts.project} — ${state}`,
    sections,
    theme,
    showSecrets: opts.showSecrets ?? false,
  });
}
