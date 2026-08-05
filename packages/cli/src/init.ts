import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DB_PROVIDER_IDS, DEPLOY_TARGET_IDS, DEFAULT_DEPLOY_TARGET_ID } from "@warehousd/broker";
import { targets } from "./deploy/targets";
import type { InitAnswers } from "./ui/prompt";

/** The port the template ships with, and what the wizard offers. */
const DEFAULT_PORT = 8722;

const WAREHOUSD_TEMPLATE =
  `project: my-app
server:
  port: ${DEFAULT_PORT}
# database:
#   managed: true                 # default — the CLI runs Postgres in Docker
#   url: ` +
  "${env:DATABASE_URL}" +
  `      # alternative: bring your own Postgres
# deploy:                         # read only by \`warehousd deploy\` — see docs/cli.md
#   target: fly                   # fly | railway | compose
#   app_name: my-app              # unique on the target: lowercase letters, digits and dashes
#   region: gru                   # whatever the target calls a region
#   database:
#     managed: true               # let the target provision Postgres, or instead:
#     url: ` +
  "${env:PROD_DATABASE_URL}" +
  `  # attach a Postgres you already run
#     provider: supabase          # supabase | neon | railway | generic — usually detected

collections:
  announcements:
    description: Company announcements
    fields:
      id:         { type: uuid,        posture: allow, pk: true }
      title:      { type: text,        posture: allow }
      summary:    { type: text,        posture: allow }
      owner:      { type: text,        posture: allow }
      updated_at: { type: timestamptz, posture: allow }

# ── More examples ─────────────────────────────────────────────────────────────
# posture: deny is the hard tier — such a field can NEVER be granted; changing it
# requires editing this file. posture: allow still means deny-by-default per user
# until a manager approves a grant covering the field.
#
#  people:
#    description: Employee directory
#    fields:
#      id:              { type: uuid, posture: allow, pk: true }
#      full_name:       { type: text, posture: allow }
#      department_name: { type: text, posture: allow, view_join: { table: departments, column: name, on: department_id } }
#      department_id:   { type: uuid, posture: allow, fk: departments.id }
#      home_address:    { type: text, posture: deny }
#
#  policies:                        # a file collection: markdown indexed for search
#    type: file
#    description: Policy documents
#    taxonomies: [category]         # bind the category vocabulary to this collection
#    source: ./docs                 # DEV content; live indexing needs \`source_live\`
#    fields:
#      title:   { posture: allow }
#      content: { posture: allow }
#      owner:   { posture: allow }
#
# taxonomies:
#   category:
#     label: Category
#     multiple: true
#     terms:
#       hr:       { label: HR }
#       benefits: { label: Benefits }
#
# synthetic:
#   documents_per_collection: { announcements: 25 }
`;

/** The commented `deploy:` block, replaced wholesale by the answered one. */
const DEPLOY_BLOCK = /^# deploy:.*\n(?:# {3,}.*\n)+/m;

/** A flag value that has to be one of a registry's ids, or a refusal that lists them. */
function oneOf<T extends string>(
  value: string | undefined,
  ids: readonly T[],
  flag: string,
): T | null {
  if (value === undefined) return null;
  const found = ids.find((id) => id === value);
  if (!found) throw new Error(`${flag} must be one of: ${ids.join(", ")} — not "${value}"`);
  return found;
}

/**
 * What `warehousd init`'s flags say, as the answers the wizard would otherwise collect.
 *
 * It lives here rather than in the commander callback so it can be tested: `program.ts` is argv
 * wiring whose only coverage is the e2e suite, and "does `--no-input --target railway` write a
 * loadable deploy block" is a question worth answering in milliseconds.
 *
 * `fromFlags` is what decides whether a non-interactive run writes a `deploy:` block at all.
 * Without `--target` there is nothing to write and `init` produces the template it always did.
 */
export function initDefaults(opts: {
  project: string;
  target?: string | undefined;
  dbProvider?: string | undefined;
}): { defaults: InitAnswers; fromFlags: boolean } {
  const dbProvider = oneOf(opts.dbProvider, DB_PROVIDER_IDS, "--db-provider");
  // A provider names where `deploy.database.url` is hosted, so it decides nothing without a deploy
  // block to sit in — and `--target` is what asks for one.
  if (dbProvider && opts.target === undefined)
    throw new Error("--db-provider needs --target: it only applies inside a deploy block.");
  return {
    defaults: {
      project: opts.project,
      port: DEFAULT_PORT,
      // Naming a provider is saying the database is somebody else's, which is the answer the
      // wizard's "bring my own" gives.
      managed: dbProvider === null,
      target: oneOf(opts.target, DEPLOY_TARGET_IDS, "--target") ?? DEFAULT_DEPLOY_TARGET_ID,
      dbProvider,
    },
    fromFlags: opts.target !== undefined,
  };
}

/**
 * A DNS label from a project name, which is what every target makes of `app_name`.
 *
 * The wizard accepts spaces, underscores and capitals in a project name; `DeploySchema` accepts
 * none of the three. A scaffold that carried the name straight across would write a file that
 * fails to load.
 */
export function appNameFor(project: string): string {
  const slug = project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return slug || "my-app";
}

/**
 * The answered `deploy:` block.
 *
 * Generated rather than uncommented in place, unlike `database:` above: the two database shapes are
 * mutually exclusive (`DeploySchema` refuses both `managed: true` and a `url`), so uncommenting
 * would mean deleting lines out of the middle of the block either way. The commented copy stays in
 * the template as the documentation of every key, which is what it is worth keeping.
 */
function renderDeployBlock(answers: InitAnswers): string {
  const lines = [
    "deploy:",
    `  target: ${answers.target}`,
    `  app_name: ${appNameFor(answers.project)}`,
    `  region: ${targets[answers.target].exampleRegion}`,
    "  database:",
  ];
  if (answers.dbProvider) {
    lines.push("    url: ${env:PROD_DATABASE_URL}", `    provider: ${answers.dbProvider}`);
  } else {
    lines.push("    managed: true");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Applies wizard answers to the scaffold. Substitution rather than a second template: the long
 * commented block below the header is the most useful thing `init` writes, and keeping one copy of
 * it is what stops the two drifting apart.
 */
export function applyAnswers(template: string, answers: InitAnswers): string {
  let out = template
    .replace(/^project: .*$/m, `project: ${answers.project}`)
    .replace(/^ {2}port: \d+$/m, `  port: ${answers.port}`);
  if (!answers.managed) {
    // Uncomment the database block the template ships commented out.
    out = out.replace(
      /^# database:\n# {3}managed: true.*\n# {3}url: (.*?) .*$/m,
      "database:\n  url: $1",
    );
  }
  // A function replacement, so a `$` in the rendered block is never read as a substitution pattern.
  return out.replace(DEPLOY_BLOCK, () => renderDeployBlock(answers));
}

// eslint-disable-next-line @typescript-eslint/require-await -- keeps the runX signatures uniform
export async function runInit(
  dir: string,
  opts?: { force?: boolean; answers?: InitAnswers },
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  // Create warehousd.yml
  const ymlPath = join(dir, "warehousd.yml");
  if (!existsSync(ymlPath) || opts?.force) {
    const content = opts?.answers
      ? applyAnswers(WAREHOUSD_TEMPLATE, opts.answers)
      : WAREHOUSD_TEMPLATE;
    writeFileSync(ymlPath, content);
    created.push("warehousd.yml");
  } else {
    skipped.push("warehousd.yml");
  }

  // Ensure .gitignore exists and append entries
  const gitignorePath = join(dir, ".gitignore");
  let gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";

  // Append warehousd.local.yml if not present
  if (!gitignoreContent.includes("warehousd.local.yml")) {
    if (gitignoreContent && !gitignoreContent.endsWith("\n")) {
      gitignoreContent += "\n";
    }
    gitignoreContent += "warehousd.local.yml\n";
  }

  // Append .warehousd/ if not present
  if (!gitignoreContent.includes(".warehousd/")) {
    if (gitignoreContent && !gitignoreContent.endsWith("\n")) {
      gitignoreContent += "\n";
    }
    gitignoreContent += ".warehousd/\n";
  }

  writeFileSync(gitignorePath, gitignoreContent);

  return { created, skipped };
}
