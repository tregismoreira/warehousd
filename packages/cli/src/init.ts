import { existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import {
  DB_PROVIDER_IDS,
  DEPLOY_TARGET_IDS,
  DEFAULT_DEPLOY_TARGET_ID,
  inferCollection,
  renderCollectionYaml,
  type InferredCollection,
} from "@warehousd/broker";
import { targets } from "./deploy/targets";
import { defaultCollectionName, payloadFor, rowsFrom } from "./import";
import type { InitAnswers } from "./ui/prompt";

/** The port the template ships with, and what the wizard offers. */
const DEFAULT_PORT = 8722;

// The two id lists are interpolated from the registries rather than hand-written, the same way the
// flag help in program.ts already builds them: a fourth target or provider must not be able to
// appear everywhere except the file `init` writes.
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
#   target: fly                   # ${DEPLOY_TARGET_IDS.join(" | ")}
#   app_name: my-app              # unique on the target: lowercase letters, digits and dashes
#   region: gru                   # whatever the target calls a region
#   database:
#     managed: true               # let the target provision Postgres, or instead:
#     url: ` +
  "${env:PROD_DATABASE_URL}" +
  `  # attach a Postgres you already run
#     provider: supabase          # ${DB_PROVIDER_IDS.join(" | ")} — usually detected

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
      // `--db-provider` is about production, and says nothing about this machine. It used to set
      // the one shared flag, so naming a deploy provider rewrote the *local* database block to
      // `${env:DATABASE_URL}` as well — and "Docker locally, Supabase in production" could not be
      // scaffolded at all.
      managed: true,
      target: oneOf(opts.target, DEPLOY_TARGET_IDS, "--target") ?? DEFAULT_DEPLOY_TARGET_ID,
      // Naming a provider is saying the production database is somebody else's, which is the answer
      // the wizard's "attach a Postgres I already run" gives.
      deployManaged: dbProvider === null,
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
  if (answers.deployManaged) {
    lines.push("    managed: true");
  } else {
    lines.push("    url: ${env:PROD_DATABASE_URL}");
    if (answers.dbProvider) lines.push(`    provider: ${answers.dbProvider}`);
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

/** The spreadsheets `init --from` will read. */
export const SCAFFOLD_EXTENSIONS = [".csv", ".xlsx", ".json"] as const;

/**
 * Infer one collection per spreadsheet in a directory.
 *
 * §P6's whole fix: the shipped template asks somebody with three thousand spreadsheets to
 * hand-declare every field and posture. This is the same inference `warehousd import map` runs,
 * called once per file — deliberately the same function, so `init` never grows its own copy and
 * the two cannot disagree about what a `salary` column is.
 *
 * A file that cannot be read is skipped with its reason rather than aborting the scaffold: one
 * unreadable workbook in a directory of forty should not cost the other thirty-nine.
 */
export function scaffoldFrom(dir: string): {
  collections: InferredCollection[];
  skipped: { file: string; reason: string }[];
} {
  const collections: InferredCollection[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const names = new Set<string>();

  const entries = existsSync(dir) ? readdirSync(dir).sort() : [];
  for (const entry of entries) {
    const abs = join(dir, entry);
    if (!statSync(abs).isFile()) continue;
    if (!(SCAFFOLD_EXTENSIONS as readonly string[]).includes(extname(entry).toLowerCase()))
      continue;
    try {
      const rows = rowsFrom(payloadFor(abs));
      if (rows.length === 0) {
        skipped.push({ file: entry, reason: "no data rows" });
        continue;
      }
      let name = defaultCollectionName(entry);
      let n = 2;
      while (names.has(name)) name = `${defaultCollectionName(entry)}_${n++}`;
      names.add(name);
      collections.push(inferCollection(name, rows));
    } catch (e) {
      skipped.push({ file: entry, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { collections, skipped };
}

/**
 * The scaffolded template: the header the plain template ships with, then one inferred block per
 * spreadsheet in place of the `announcements` example.
 */
export function applyScaffold(template: string, collections: InferredCollection[]): string {
  if (collections.length === 0) return template;
  const header = template.slice(0, template.indexOf("collections:"));
  const trailer = template.slice(template.indexOf("# ── More examples"));
  const blocks = collections.map((c) => renderCollectionYaml(c).replace(/^collections:\n/, ""));
  return [
    header.trimEnd(),
    "",
    "# Inferred from your spreadsheets. Every posture below is a GUESS about a column name, not a",
    "# reading of the data — read each one before you apply this.",
    "collections:",
    blocks.join("\n"),
    "",
    trailer,
  ].join("\n");
}

// eslint-disable-next-line @typescript-eslint/require-await -- keeps the runX signatures uniform
export async function runInit(
  dir: string,
  opts?: { force?: boolean; answers?: InitAnswers; from?: string },
): Promise<{
  created: string[];
  skipped: string[];
  inferred?: InferredCollection[];
  unreadable?: { file: string; reason: string }[];
}> {
  const created: string[] = [];
  const skipped: string[] = [];

  const scaffold = opts?.from ? scaffoldFrom(opts.from) : null;

  // Create warehousd.yml
  const ymlPath = join(dir, "warehousd.yml");
  if (!existsSync(ymlPath) || opts?.force) {
    const base = opts?.answers
      ? applyAnswers(WAREHOUSD_TEMPLATE, opts.answers)
      : WAREHOUSD_TEMPLATE;
    const content = scaffold ? applyScaffold(base, scaffold.collections) : base;
    writeFileSync(ymlPath, content);
    created.push("warehousd.yml");
  } else {
    skipped.push("warehousd.yml");
  }

  // Ensure .gitignore exists and carries both entries. `warehousd.local.yml` holds the overrides
  // for this machine; `.warehousd/` holds generated state and credentials.
  const gitignorePath = join(dir, ".gitignore");
  let gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  for (const entry of ["warehousd.local.yml", ".warehousd/"]) {
    if (gitignoreContent.includes(entry)) continue;
    if (gitignoreContent && !gitignoreContent.endsWith("\n")) gitignoreContent += "\n";
    gitignoreContent += `${entry}\n`;
  }

  writeFileSync(gitignorePath, gitignoreContent);

  return {
    created,
    skipped,
    ...(scaffold ? { inferred: scaffold.collections, unreadable: scaffold.skipped } : {}),
  };
}
