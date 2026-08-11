import { existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import {
  CONTAINER_RUNTIME_IDS,
  DB_PROVIDER_IDS,
  DEFAULT_CONTAINER_RUNTIME_ID,
  DEPLOY_TARGET_IDS,
  DEFAULT_DEPLOY_TARGET_ID,
  PROVISIONABLE_DB_PROVIDER_IDS,
  inferCollection,
  renderCollectionYaml,
  type DbProviderId,
  type DeployTargetId,
  type InferredCollection,
} from "@warehousd/broker";
import { targets } from "./deploy/targets";
import { hostFor, localHosts } from "./db/hosts";
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
#   runtime: docker               # ${CONTAINER_RUNTIME_IDS.join(" | ")}
# database:
#   managed: true                 # default — the CLI runs Postgres in a container
#   provider: supabase            # optional — run their local stack instead of ours
#   url: ` +
  "${env:DATABASE_URL}" +
  `      # alternative: bring your own Postgres
# deploy:                         # read only by \`warehousd deploy\` — see docs/cli.md
#   target: fly                   # ${DEPLOY_TARGET_IDS.join(" | ")}
#   app_name: my-app              # unique on the target: lowercase letters, digits and dashes
#   region: gru                   # whatever the target calls a region
#   database:                     # exactly one of the three shapes below
#     managed: true               # 1. let the target provision Postgres
#     managed: true               # 2. or let a provider's CLI create one:
#     provider: supabase          #    ${PROVISIONABLE_DB_PROVIDER_IDS.join(" | ")}
#     region: sa-east-1           #    the database's region, not the target's
#     url: ` +
  "${env:PROD_DATABASE_URL}" +
  `  # 3. or attach a Postgres you already run
#     provider: supabase          #    ${DB_PROVIDER_IDS.join(" | ")} — usually detected

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

/**
 * What `--prod-db` accepts, and the three shapes `deploy.database` takes.
 *
 * `target` and `existing` are not provider ids and never will be — they name *who* provides the
 * database rather than *which* provider — so the list is built from the registry with those two
 * around it rather than being a second hand-maintained copy.
 */
export const PROD_DB_IDS = ["target", ...PROVISIONABLE_DB_PROVIDER_IDS, "existing"] as const;

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
  devDb?: string | undefined;
  prodDb?: string | undefined;
  prodDbHost?: string | undefined;
  prodDbRegion?: string | undefined;
  prodDbOrg?: string | undefined;
  runtime?: string | undefined;
  manual?: boolean | undefined;
}): { defaults: InitAnswers; fromFlags: boolean } {
  const runtime =
    oneOf(opts.runtime, CONTAINER_RUNTIME_IDS, "--runtime") ?? DEFAULT_CONTAINER_RUNTIME_ID;

  // `--dev-db` takes a provider id whose local stack should run it, or `docker` for warehousd's
  // own container, or `url` to bring your own. It decides the top-level `database:` block and
  // nothing else: a production answer must never rewrite this one, which is what made "a container
  // locally, Supabase in production" — the ordinary case — unscaffoldable when one flag meant both.
  const devDb = opts.devDb ?? "docker";
  const localDbProvider =
    devDb === "docker" || devDb === "url" ? null : oneOf(devDb, DB_PROVIDER_IDS, "--dev-db");
  if (localDbProvider && !hostFor(localDbProvider)?.local)
    throw new Error(
      `--dev-db ${localDbProvider} has no local stack. Use \`docker\`, \`url\`, or one of: ` +
        `${localHosts()
          .map((h) => h.id)
          .join(", ")}`,
    );

  // `--prod-db` decides `deploy.database`, and it is the only flag that does. It replaced a
  // `--db-provider` that meant "create one there" or "this is who hosts the url I am attaching"
  // depending on whether `--attach-db` was also passed — two questions on one flag, disambiguated
  // by a second flag that existed for no other purpose.
  const prodDb = oneOf(opts.prodDb, PROD_DB_IDS, "--prod-db");
  const provisioningHost = prodDb === null ? null : (hostFor(prodDb as DbProviderId) ?? null);
  const attaching = prodDb === "existing";

  // Who hosts a Postgres you already run. Only ever an override on the hostname, so it decides
  // nothing unless something is being attached.
  const prodDbHost = oneOf(opts.prodDbHost, DB_PROVIDER_IDS, "--prod-db-host");
  if (prodDbHost && !attaching)
    throw new Error(
      "--prod-db-host only applies to a database you already run: pass --prod-db existing, or drop it.",
    );

  // A region and an organisation both name where to *build* something, so neither decides anything
  // when nothing is being built.
  if (opts.prodDbRegion !== undefined && !provisioningHost)
    throw new Error(
      `--prod-db-region needs --prod-db to name a provider that creates the database (${PROVISIONABLE_DB_PROVIDER_IDS.join(", ")}): it says where to build it.`,
    );
  if (opts.prodDbOrg !== undefined && !provisioningHost)
    throw new Error(
      `--prod-db-org needs --prod-db to name a provider that creates the database (${PROVISIONABLE_DB_PROVIDER_IDS.join(", ")}): it says which organisation to build it in.`,
    );

  // No deploy answers at all means no `deploy:` block, and that is the right default rather than an
  // omission: the block is read only by `warehousd deploy`, and scaffolding one for somebody who
  // has not decided where to deploy is a file full of guesses they have to review.
  const fromFlags = opts.target !== undefined || prodDb !== null;

  return {
    defaults: {
      project: opts.project,
      port: DEFAULT_PORT,
      managed: devDb !== "url",
      target: fromFlags
        ? (oneOf(opts.target, DEPLOY_TARGET_IDS, "--target") ?? DEFAULT_DEPLOY_TARGET_ID)
        : null,
      // Two ways to be managed: the target builds the database, or a provider's CLI does. Only
      // `existing` means "attach a Postgres I already run".
      deployManaged: !attaching,
      dbProvider: attaching ? prodDbHost : (provisioningHost?.id ?? null),
      guided: !opts.manual,
      runtime,
      localDbProvider,
      dbRegion: opts.prodDbRegion ?? null,
      dbOrg: opts.prodDbOrg ?? null,
    },
    fromFlags,
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
function renderDeployBlock(answers: InitAnswers & { target: DeployTargetId }): string {
  const lines = [
    "deploy:",
    `  target: ${answers.target}`,
    `  app_name: ${appNameFor(answers.project)}`,
    `  region: ${targets[answers.target].exampleRegion}`,
    "  database:",
  ];
  // `deployManaged` is the half that decides the shape; the host lookup only decides *who* builds
  // it. A provider named alongside an attached url is the override it has always been, and must
  // not be read as "create one here".
  const provisioning =
    answers.deployManaged && answers.dbProvider ? hostFor(answers.dbProvider) : undefined;
  if (provisioning) {
    // The third shape: warehousd creates it, through that provider's own CLI. `region` belongs to
    // the database rather than to the target, which is why it sits inside this block.
    lines.push("    managed: true");
    lines.push(`    provider: ${provisioning.id}`);
    lines.push(`    region: ${answers.dbRegion ?? provisioning.exampleRegions.split(",")[0]}`);
    // Omitted when there is nothing to disambiguate — the host resolves a single organisation on
    // its own, and a key naming the only possible answer is noise in a reviewed file.
    if (answers.dbOrg) lines.push(`    org: ${answers.dbOrg}`);
  } else if (answers.deployManaged) {
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

  // Written only when it is not the default, so an ordinary project's warehousd.yml stays as short
  // as it was. A key whose value equals the default is noise in a file meant to be reviewed.
  if (answers.runtime !== DEFAULT_CONTAINER_RUNTIME_ID) {
    out = out.replace(/^ {2}port: \d+$/m, `  port: ${answers.port}\n  runtime: ${answers.runtime}`);
  }

  // Whose local stack runs the dev database. Uncomments the same block `!managed` does, but with
  // a provider instead of a url — the two are mutually exclusive (see ConfigSchema).
  if (answers.localDbProvider) {
    // The commented block is three lines now — managed, provider, url — so the match has to span
    // all three or it would leave a stray `#   url:` behind the uncommented block.
    out = out.replace(
      /^# database:\n# {3}managed: true.*\n# {3}provider: .*\n# {3}url: .*$/m,
      `database:\n  managed: true\n  provider: ${answers.localDbProvider}`,
    );
  }

  if (!answers.managed) {
    // Uncomment the database block the template ships commented out.
    out = out.replace(
      /^# database:\n# {3}managed: true.*\n# {3}provider: .*\n# {3}url: (.*?) .*$/m,
      "database:\n  url: $1",
    );
  }
  // "Not yet" leaves the commented block exactly as the template ships it, which is the
  // documentation of every key and the thing somebody uncomments when they do decide.
  if (answers.target === null) return out;

  // A function replacement, so a `$` in the rendered block is never read as a substitution pattern.
  const answered = { ...answers, target: answers.target };
  return out.replace(DEPLOY_BLOCK, () => renderDeployBlock(answered));
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
