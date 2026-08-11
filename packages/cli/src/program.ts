// The command surface: commander wiring, global flags, and the process-level error handler.
//
// Split from index.ts, which keeps the functions the suites import directly (resolveDbUrl,
// runApply, runSeed, runIndex). The two had grown into one 466-line file mixing a library with a
// CLI, and only the library half can be unit-tested: every action below is an argv-driven callback
// whose real coverage comes from packages/cli/test/e2e/lifecycle.e2e.test.ts, which drives the
// built bundle as a subprocess and deliberately collects no coverage (see vitest.e2e.config.ts).
// That is the same reason docker.ts, start.ts, stop.ts and status.ts are excluded in
// vitest.coverage.ts, and this file is excluded there on the same grounds.
//
// tsup's entry is this file, emitted as dist/index.cjs so the bin path is unchanged.

import { Command } from "commander";
import { resolve, basename } from "node:path";
import {
  CONTAINER_RUNTIME_IDS,
  DEPLOY_TARGET_IDS,
  DB_PROVIDER_IDS,
  dbProviders,
} from "@warehousd/broker";
import { dbHosts, hostFor, localHosts } from "./db/hosts";
import { targets } from "./deploy/targets";
import { ensureToolsFor } from "./init-tools";
import { resolveDbUrl, tryResolveDbUrl, runApply, runSeed, runIndex, runEmbed } from "./index";
import { buildPlan, renderPlan, writeMigration, migrationStatus } from "./migrate";
import { runInit, initDefaults, PROD_DB_IDS } from "./init";
import {
  runImportMap,
  runImportRun,
  runImportValidate,
  formatMapResult,
  formatValidateResult,
} from "./import";
import { runStart } from "./start";
import { runStop } from "./stop";
import { runStatus } from "./status";
import { runDeploy } from "./deploy";
import { formatOutputs } from "./outputs";
import { ensureState } from "./state";
import { setVerbose } from "./verbose";
import { runDoctor } from "./preflight";
import { runLogs } from "./commands/logs";
import { runOpen, type Target } from "./commands/open";
import { collectSecrets, secretsJson } from "./commands/secrets";
import { resolveTheme, type Theme } from "./ui/theme";
import { rcNotice } from "./ui/rc-notice";
import { brandBanner } from "./ui/brand";
import { createStdReporter } from "./ui/reporter";
import { renderStatus, renderChecks, renderPanel, renderSuccess } from "./ui/render";
import { isInteractive, promptInit, NonInteractiveError, type InitAnswers } from "./ui/prompt";
import { explain, formatExplained } from "./ui/errors";

// WAREHOUSD_CLI_VERSION is defined by tsup at build time; fallback for source runs.
declare const WAREHOUSD_CLI_VERSION: string | undefined;

// Hoisted because two things read it now: `--version`, and the release-candidate notice below,
// which prints only while this is a prerelease. The fallback is one too, so a source run says it.
const version = typeof WAREHOUSD_CLI_VERSION !== "undefined" ? WAREHOUSD_CLI_VERSION : "0.0.0-dev";

const program = new Command();
program
  .name("warehousd")
  .description("warehousd CLI")
  .version(version)
  // `--help` is on every command already; the `help [command]` subcommand only pads the list.
  .helpCommand(false)
  // clig.dev: suggest, do not correct. Commander gives both for free and neither was switched on.
  .showHelpAfterError("(run `warehousd --help` for the full list)")
  .showSuggestionAfterError(true)
  .option("--json", "machine-readable output on stdout", false)
  .option("-q, --quiet", "only errors and results", false)
  .option("--no-color", "disable colour (also honours NO_COLOR)")
  .option("--verbose", "echo every command warehousd shells out to", false)
  .addHelpText(
    "after",
    `
Examples:
  $ warehousd init                 set up a project here, with a few questions
  $ warehousd start                bring the stack up and print its URLs
  $ warehousd status --json | jq   machine-readable health
  $ warehousd logs --follow        tail the server container
  $ warehousd doctor               check Docker, image, ports and config
  $ warehousd secrets --show       reveal the masked credentials

  Answering init from flags instead of the wizard:
  $ warehousd init --no-input --dev-db docker --target fly \\
      --prod-db neon --prod-db-region aws-sa-east-1
`,
  );

// Global flags live on the root command, so every action reads them from one place.
type Globals = { json: boolean; quiet: boolean; color: boolean; verbose: boolean };

function globals(): Globals {
  const o = program.opts();
  return {
    json: Boolean(o.json),
    quiet: Boolean(o.quiet),
    color: o.color !== false,
    verbose: Boolean(o.verbose),
  };
}

function ui() {
  const g = globals();
  setVerbose(g.verbose);
  const theme = resolveTheme({
    isTTY: Boolean(process.stderr.isTTY),
    env: process.env,
    noColor: !g.color,
    json: g.json,
  });
  const reporter = createStdReporter({
    theme,
    // Progress is drawn on stderr, so it is stderr's TTY-ness that decides whether to animate.
    isTTY: Boolean(process.stderr.isTTY) && !g.json,
    quiet: g.quiet || g.json,
  });
  return { ...g, theme, reporter };
}

/**
 * The wordmark, on the three commands where somebody is bringing something up.
 *
 * Not on all of them: `logs`, `status` and `secrets` are things you run in a loop, and a banner
 * above each one would be six rows of decoration between you and the answer. `init`, `start` and
 * `restart` are the commands with a beginning.
 *
 * stderr, like all narration — `warehousd start 2>/dev/null` must still print the summary alone.
 * `brandBanner` returns null off a TTY and under --quiet/--json, so this is a no-op in a pipe.
 *
 * It lands *below* the release-candidate notice, which is written before commander parses argv
 * (see the bottom of this file) and so cannot know which command is about to run. Putting the
 * wordmark first would mean sniffing argv before parsing, which is worse than the ordering. The
 * notice retires itself at 1.0 and the wordmark becomes the first thing printed then.
 */
function banner(g: { theme: Theme; quiet: boolean; json: boolean }): void {
  const art = brandBanner({
    theme: g.theme,
    isTTY: Boolean(process.stderr.isTTY),
    quiet: g.quiet,
    json: g.json,
    columns: process.stderr.columns,
  });
  // A blank line above and below. `brandBanner` deliberately carries neither, because whether
  // there is a release-candidate notice sitting above it is not something it can know.
  if (art) process.stderr.write(`\n${art}\n\n`);
}

/**
 * The result of a command, in whichever of the two forms was asked for. Always stdout — this is
 * the product, not the narration.
 *
 * `--quiet` drops the human confirmation but never the JSON: a caller that asked for a payload and
 * got silence would have no way to tell success from failure except the exit code, which is the
 * thing `--json` exists to improve on.
 */
function emit(value: unknown, human: string): void {
  const g = globals();
  if (g.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (g.quiet) return;
  process.stdout.write(`${human}\n`);
}

program
  .command("init")
  .description("set up a warehousd project in this directory")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--force", "overwrite an existing warehousd.yml")
  .option("--no-input", "never prompt; write the default template")
  .option(
    "--from <dir>",
    "infer a collection per spreadsheet in this directory instead of the example",
  )
  .option("--runtime <id>", `container engine: ${CONTAINER_RUNTIME_IDS.join(", ")}`)
  // Every value joined into one list rather than "docker, url, or one of <hosts>", which read as
  // "or one of supabase" while exactly one host has a local stack.
  .option(
    "--dev-db <id>",
    `database for development on this machine: ${["docker", "url", ...localHosts().map((h) => h.id)].join(", ")}`,
  )
  .option("--target <id>", `where a deploy would go: ${DEPLOY_TARGET_IDS.join(", ")}`)
  .option("--prod-db <id>", `database in production: ${PROD_DB_IDS.join(", ")}`)
  .option(
    "--prod-db-host <id>",
    `who hosts the database you attach, with --prod-db existing: ${DB_PROVIDER_IDS.join(", ")}`,
  )
  .option("--prod-db-region <code>", "where to create it — the database's region, not the target's")
  .option(
    "--prod-db-org <id>",
    "organisation to create it in (Supabase, when you have more than one)",
  )
  .option("--manual", "skip guided setup and paste connection details yourself")
  .option("--install-missing", "install any provider CLI that is missing, without asking")
  .action(async (o) => {
    const { reporter, theme, json, quiet } = ui();
    banner({ theme, quiet, json });
    const { defaults, fromFlags } = initDefaults({
      project: basename(resolve(o.dir)) || "my-app",
      target: o.target,
      runtime: o.runtime,
      devDb: o.devDb,
      prodDb: o.prodDb,
      prodDbHost: o.prodDbHost,
      prodDbRegion: o.prodDbRegion,
      prodDbOrg: o.prodDbOrg,
      manual: o.manual,
    });

    // The wizard only runs where there is somebody to answer it. Piped, in CI, under --json or
    // --no-input, `init` writes the template — with the deploy block filled in when --target
    // named one, so a non-interactive run can still specify every field.
    const interactive = o.input !== false && !json && isInteractive();
    const answers = interactive ? await promptInit(defaults) : fromFlags ? defaults : null;
    if (interactive && !answers) {
      reporter.fail("Cancelled.");
      process.exit(1);
    }

    // Before the file is written, so the operator finds out what is missing while the choice that
    // needs it is still on screen. Never fatal — see ensureToolsFor.
    if (answers && !json) {
      await ensureToolsFor(answers, {
        reporter,
        installMissing: o.installMissing,
        interactive,
      });
    }

    const r = await runInit(o.dir, {
      force: o.force,
      ...(answers ? { answers } : {}),
      ...(o.from ? { from: o.from } : {}),
    });
    if (json) {
      emit(r, "");
      return;
    }
    // The files still narrate on stderr as they happen; the panel below is the summary, and it is
    // the product, so it goes to stdout.
    for (const f of r.created) reporter.step("created", f).done();
    for (const f of r.skipped) reporter.step("skipped", `${f} (already exists)`).done();
    for (const u of r.unreadable ?? []) reporter.warn(`${u.file}: ${u.reason}`);

    const closed = (r.inferred ?? []).flatMap((c) => c.fields.filter((f) => f.closedBecause));
    reporter.out(
      renderSuccess({
        headline: "Project ready",
        theme,
        sections: [{ fields: initSummary(answers, r) }],
        footer: [
          // Deny-by-default is a guess about a column NAME, never a reading of the data, and
          // saying so is the difference between a safe scaffold and one somebody trusts.
          ...(r.inferred?.length
            ? [
                `${closed.length} field(s) closed by default — every posture is a guess about a name, not a reading of the data.`,
                "Read warehousd.yml before `warehousd apply`.",
              ]
            : []),
          "Next: warehousd start",
        ],
      }),
    );
  });

/** What `init` decided, for the summary panel. Omits a row it has no answer for. */
function initSummary(
  answers: InitAnswers | null,
  result: { created: string[]; skipped: string[]; inferred?: { name: string }[] },
): { label: string; value: string }[] {
  const files = [...result.created, ...result.skipped.map((f) => `${f} (kept)`)];
  if (!answers) return [{ label: "Files", value: files.join(", ") }];

  const devDb = answers.localDbProvider
    ? `${dbHosts[answers.localDbProvider as keyof typeof dbHosts]?.label ?? answers.localDbProvider} locally`
    : answers.managed
      ? "Postgres in a container warehousd runs"
      : "your own, via database.url";

  return [
    { label: "Project", value: answers.project },
    { label: "Port", value: String(answers.port) },
    { label: "Dev data", value: devDb },
    {
      label: "Deploy",
      value: answers.target === null ? "not set up yet" : targets[answers.target].label,
    },
    ...(answers.target === null ? [] : [{ label: "Prod data", value: prodDbSummary(answers) }]),
    ...(result.inferred?.length
      ? [{ label: "Collections", value: `${result.inferred.length} inferred from your files` }]
      : []),
    { label: "Files", value: files.join(", ") },
  ];
}

function prodDbSummary(answers: InitAnswers): string {
  if (!answers.deployManaged) {
    const host = answers.dbProvider ? dbProviders[answers.dbProvider].label : "one you already run";
    return `${host}, attached by url`;
  }
  const host = answers.dbProvider ? hostFor(answers.dbProvider) : undefined;
  // The row above already names the target, so repeating it here only made the line long — and
  // "provided by Self-hosted (Docker Compose)" was the sentence that showed it.
  return host ? `${host.label} — created on your first deploy` : "Alongside the app";
}
program
  .command("start")
  .description("start the server and its database, then print the URLs")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("-s, --seed <n>", "synthetic seed", "42")
  .option("--show-secrets", "print credentials in full instead of masked", false)
  .action(async (o) => {
    const { reporter, theme, json, quiet } = ui();
    banner({ theme, quiet, json });
    const began = Date.now();
    const outputs = await runStart(o.dir, { seed: Number(o.seed), reporter });
    const st = ensureState(o.dir);

    if (json) {
      // The machine contract keeps full values: a caller that asked for JSON asked for the secret.
      process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
      return;
    }
    const elapsed = `ready in ${((Date.now() - began) / 1000).toFixed(1)}s`;
    reporter.out(
      formatOutputs(
        outputs,
        { adminEmail: "admin@warehousd.local", adminPassword: st.adminPassword },
        { theme, showSecrets: o.showSecrets, elapsed },
      ),
    );
  });
program
  .command("apply")
  .description("apply config changes to a running stack, without a restart")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .action(async (o) => {
    const { reporter, theme } = ui();
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runApply(o.dir, db, { reporter });
    // A rebuilt synth table is empty until the generator runs again. Saying so is the difference
    // between "apply worked" and an operator wondering where their dev data went.
    const fields = [
      ...(r.migrated.length ? [{ label: "Migrations", value: r.migrated.join(", ") }] : []),
      ...(r.rebuilt.length ? [{ label: "Rebuilt", value: r.rebuilt.join(", ") }] : []),
    ];
    emit(
      { applied: true, ...r },
      renderSuccess({
        headline: "Configuration applied",
        theme,
        sections: fields.length ? [{ fields }] : [],
        ...(r.rebuilt.length
          ? { footer: ["A rebuilt collection is empty until you run `warehousd seed`"] }
          : {}),
      }),
    );
  });
const migrate = program
  .command("migrate")
  .description("plan and write migrations for changes that would destroy live data");
migrate
  .command("plan")
  .description("what a config change would do to data you already have")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .action(async (o) => {
    ui();
    // No `resolveDbUrl` throw here: a plan from the last deploy snapshot is still worth printing
    // when there is no database to reach, which is the normal case before a deploy.
    const db = tryResolveDbUrl(o.dir, o.db);
    const plan = await buildPlan(o.dir, db);
    emit(plan, renderPlan(plan));
  });
migrate
  .command("generate")
  .description("write the pending changes as a reviewable SQL migration")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("-n, --name <slug>", "name for the migration file", "schema-change")
  .action(async (o) => {
    ui();
    const db = tryResolveDbUrl(o.dir, o.db);
    const plan = await buildPlan(o.dir, db);
    const blocking = plan.changes.filter((c) => c.destructive);
    if (blocking.length === 0) {
      emit({ written: null, changes: [] }, "nothing to migrate");
      return;
    }
    const path = writeMigration(o.dir, plan.changes, o.name);
    const review = blocking.filter((c) => c.reviewRequired).length;
    emit(
      { written: path, changes: blocking, reviewRequired: review },
      review > 0
        ? `wrote ${path} — ${review} statement(s) are commented out pending your review`
        : `wrote ${path} — every statement is lossless and ready to run`,
    );
  });
migrate
  .command("status")
  .description("which project migrations have been applied")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .action(async (o) => {
    ui();
    const rows = await migrationStatus(o.dir, resolveDbUrl(o.dir, o.db));
    emit(
      rows,
      rows.length === 0
        ? "no migrations in this project"
        : rows.map((r) => `${r.state.padEnd(8)} ${r.version}`).join("\n"),
    );
  });
program
  .command("seed")
  .description("regenerate synthetic data, then re-index file collections")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("-s, --seed <n>", "seed", "42")
  .option("--no-reindex", "leave file collections as they are")
  .action(async (o) => {
    const { reporter, theme } = ui();
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runSeed(o.dir, db, Number(o.seed), { reindex: o.reindex, reporter });
    emit(
      { seeded: true, seed: r.seed, reindexed: r.reindexed },
      renderSuccess({
        headline: "Synthetic data regenerated",
        theme,
        sections: [
          {
            fields: [
              { label: "Seed", value: String(r.seed) },
              ...(r.reindexed.length
                ? [{ label: "Re-indexed", value: r.reindexed.join(", ") }]
                : []),
            ],
          },
        ],
      }),
    );
  });
program
  .command("index <collection>")
  .description("re-index a file collection")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("--env <env>", "dev|live", "dev")
  .option("--source <dir>", "override source directory")
  .option("--no-embed", "skip embedding the new chunks (see `warehousd embed`)")
  .action(async (collection, o) => {
    const { reporter } = ui();
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runIndex(o.dir, db, collection, {
      env: o.env,
      source: o.source,
      embed: o.embed,
      reporter,
    });
    emit(r, `indexed=${r.indexed} skipped=${r.skipped} deleted=${r.deleted}`);
  });
program
  .command("embed [collection]")
  .description("fill embeddings for file collections (resumable)")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("--env <env>", "dev|live", "dev")
  .action(async (collection, o) => {
    const { reporter } = ui();
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runEmbed(o.dir, db, { collection, env: o.env, reporter });
    emit(r, `embedded=${r.embedded} collections=${r.collections.join(",")}`);
  });
// `import` mirrors `migrate plan|generate|status`: a noun with verbs under it, one project dir
// option each. Import used to be reachable only from /admin/import, so it could not be scripted,
// rerun, or put in CI.
const importCmd = program
  .command("import")
  .description("map a spreadsheet onto a collection, validate it, and load it");
// The .xlsx reader makes three choices a spreadsheet library would make silently, and each one is
// a way data gets quietly corrupted. They are documented here rather than only in the source
// because the person who needs to know is the person holding the file.
importCmd.addHelpText(
  "after",
  `
Reading an .xlsx:
  formula cells    import their CACHED VALUE — the number Excel last calculated and saved.
                   A workbook saved without cached values imports those cells as empty.
  dates            are converted from Excel's serial numbers, not from the displayed text.
  merged cells     carry their value in the top-left cell only; the rest of the range is empty.
  text columns     keep leading zeros — "007" imports as "007", never as 7.
  multiple sheets  must be chosen with --sheet; nothing is guessed.
`,
);
importCmd
  .command("map <file>")
  .description("propose a collections block, or a column mapping, from a spreadsheet")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("-c, --collection <name>", "collection name (default: the file's name)")
  .option("--sheet <name>", "which sheet of an .xlsx to read")
  .option("--header-row <n>", "1-based row the headers are on", "1")
  .action((file, o) => {
    ui();
    const r = runImportMap(o.dir, file, {
      collection: o.collection,
      sheet: o.sheet,
      headerRow: Number(o.headerRow),
    });
    // stdout, and stdout only: this output exists to be piped into an editor or a clipboard.
    // Nothing is written — see runImportMap.
    emit(r, formatMapResult(r));
  });
importCmd
  .command("validate <collection> <file>")
  .description("check a file against a collection — offline, or --live against the database")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url (implies --live)")
  .option("--live", "also run a dry run against the database", false)
  .option("-m, --mode <mode>", "append|upsert|delete", "append")
  .option("--sheet <name>", "which sheet of an .xlsx to read")
  .option("--header-row <n>", "1-based row the headers are on", "1")
  .action(async (collection, file, o) => {
    const { reporter } = ui();
    // The static layer needs no database at all, which is the point of it: it runs in CI, on a
    // laptop, against a file somebody just emailed.
    const live = o.live || o.db ? resolveDbUrl(o.dir, o.db) : undefined;
    const r = await runImportValidate(o.dir, file, collection, {
      live,
      mode: o.mode,
      sheet: o.sheet,
      headerRow: Number(o.headerRow),
      reporter,
    });
    emit(r, formatValidateResult(r));
    process.exit(r.ok ? 0 : 1);
  });
importCmd
  .command("run <collection> <file>")
  .description("load a file into a collection")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("-m, --mode <mode>", "append|upsert|delete", "append")
  .option("--dry-run", "run every statement and roll back", false)
  .option("--sheet <name>", "which sheet of an .xlsx to read")
  .option("--header-row <n>", "1-based row the headers are on", "1")
  .action(async (collection, file, o) => {
    const { reporter, theme } = ui();
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runImportRun(o.dir, db, collection, file, {
      mode: o.mode,
      dryRun: o.dryRun,
      sheet: o.sheet,
      headerRow: Number(o.headerRow),
      reporter,
    });
    if (!r.ok) {
      emit(
        r,
        formatValidateResult({
          ok: false,
          layer: "live",
          rows: 0,
          collection,
          summary: r.summary,
          blindSpot: null,
        }),
      );
      process.exit(1);
    }
    emit(
      r,
      renderSuccess({
        // A dry run rolls everything back, so calling it an import would be a lie about the state
        // of the database — see runImportRun.
        headline: r.dryRun ? "Import preview complete" : "Import complete",
        theme,
        sections: [
          {
            fields: [
              { label: "Collection", value: collection },
              { label: "Added", value: String(r.inserted) },
              { label: "Revised", value: String(r.updated) },
              { label: "Deleted", value: String(r.deleted) },
            ],
          },
        ],
        ...(r.dryRun ? { footer: ["Nothing was written — every statement was rolled back."] } : {}),
      }),
    );
  });

program
  .command("stop")
  .description("stop the containers, keeping your data")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--destroy", "remove volume and data (irreversible)")
  .option("-y, --yes", "skip confirmation for --destroy")
  .action(async (o) => {
    const { theme } = ui();
    await runStop(o.dir, { destroy: o.destroy, yes: o.yes });
    // `emit` branches on --json before it reads the human string, so building the panel
    // unconditionally costs a machine-readable run nothing.
    emit(
      { stopped: true, destroyed: Boolean(o.destroy) },
      renderSuccess({
        headline: "Stack stopped",
        theme,
        sections: [
          {
            fields: [
              {
                label: "Removed",
                value: o.destroy ? "containers, volume and network" : "containers",
              },
            ],
          },
        ],
        // Data surviving a `stop` is the difference between the two runs, and the one thing
        // somebody wants confirmed before they walk away.
        footer: [
          o.destroy
            ? "The volume is gone — every document in it went with it."
            : "Your data is untouched. `warehousd start` brings it back.",
        ],
      }),
    );
  });
program
  .command("status")
  .description("is this project's stack up, and on which URLs")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--show-secrets", "print credentials in full instead of masked", false)
  .action(async (o) => {
    const { theme, json } = ui();
    const result = await runStatus(o.dir);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ healthy: result.healthy, project: result.project, containers: result.containers, outputs: result.outputs }, null, 2)}\n`,
      );
    } else if (result.containers.length === 0) {
      // Indented and spaced like the panel it stands in for. Flush at column 0 it collided with
      // the release-candidate notice above it and lined up with nothing.
      process.stdout.write("\n  No containers for this project. Run `warehousd start`.\n\n");
    } else {
      process.stdout.write(
        `${renderStatus({
          project: result.project,
          healthy: result.healthy,
          containers: result.containers,
          outputs: result.outputs,
          theme,
          showSecrets: o.showSecrets,
        })}\n`,
      );
    }
    process.exit(result.healthy ? 0 : 1);
  });
program
  .command("restart")
  .description("stop, then start again")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("-s, --seed <n>", "synthetic seed", "42")
  .option("--show-secrets", "print credentials in full instead of masked", false)
  .action(async (o) => {
    const { reporter, theme, json, quiet } = ui();
    banner({ theme, quiet, json });
    const began = Date.now();
    await runStop(o.dir, { yes: true });
    reporter.step("stopped", "containers").done();
    const outputs = await runStart(o.dir, { seed: Number(o.seed), reporter });
    const st = ensureState(o.dir);
    if (json) {
      process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
      return;
    }
    reporter.out(
      formatOutputs(
        outputs,
        { adminEmail: "admin@warehousd.local", adminPassword: st.adminPassword },
        {
          theme,
          showSecrets: o.showSecrets,
          elapsed: `ready in ${((Date.now() - began) / 1000).toFixed(1)}s`,
        },
      ),
    );
  });
program
  .command("logs")
  .description("container logs — the answer to most 'it started but nothing works'")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("-f, --follow", "stream new output until interrupted", false)
  .option("-n, --tail <n>", "number of lines to show", "100")
  .option("--service <name>", "server|db", "server")
  .action(async (o) => {
    if (o.service !== "server" && o.service !== "db") {
      throw new Error(`--service must be "server" or "db", not "${o.service}"`);
    }
    const { json } = ui();
    // A stream has no last element, so there is no object to close. Refusing beats accepting the
    // flag and quietly emitting raw text that no parser asked for.
    if (json && o.follow) {
      throw new Error("--json cannot be combined with --follow: a stream has no end to serialise.");
    }
    const out = await runLogs(o.dir, {
      follow: o.follow,
      tail: Number(o.tail),
      service: o.service,
    });
    if (out === null) return; // --follow already streamed it
    if (json) {
      emit({ service: o.service, lines: out === "" ? [] : out.split("\n") }, "");
      return;
    }
    process.stdout.write(`${out}\n`);
  });
program
  .command("open [target]")
  .description("open the admin UI (or mcp|api) in a browser")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .action((target: string | undefined, o) => {
    const t = (target ?? "admin") as Target;
    if (!["admin", "mcp", "api"].includes(t)) {
      throw new Error(`Unknown target "${t}". Use admin, mcp or api.`);
    }
    const { reporter, json } = ui();
    const r = runOpen(o.dir, t);
    if (json) emit(r, "");
    else if (r.opened) reporter.step("opening", r.url).done();
    else process.stdout.write(`${r.url}\n`);
  });
program
  .command("doctor")
  .description("check Docker, the server image, ports and config before anything breaks")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  // Opt-in because it dials the production database and the target's CLI, which the rest of doctor
  // does not: everything else here is a question about this machine.
  .option(
    "--deploy",
    "also run the deploy pre-flight against deploy.target and its database",
    false,
  )
  .action(async (o) => {
    const { theme, json } = ui();
    const result = await runDoctor(o.dir, { deploy: o.deploy });
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`\n${renderChecks(result.checks, theme)}\n\n`);
    }
    process.exit(result.ok ? 0 : 1);
  });
program
  .command("secrets")
  .description("show the generated credentials, masked unless --show")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--show", "print them in full", false)
  .action((o) => {
    const { theme, json } = ui();
    if (json) {
      process.stdout.write(`${JSON.stringify(secretsJson(o.dir), null, 2)}\n`);
      return;
    }
    const entries = collectSecrets(o.dir);
    process.stdout.write(
      `${renderPanel({
        title: "warehousd secrets",
        sections: [
          {
            fields: entries.map((e) => ({ label: e.label, value: e.value, secret: e.secret })),
          },
        ],
        theme,
        showSecrets: o.show,
        ...(o.show ? {} : { footer: ["Masked — add --show to reveal, or --json for a script"] }),
      })}\n`,
    );
  });
program
  .command("deploy")
  .description("deploy this project to the target in warehousd.yml, or tear it down with --destroy")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--allow-local-login", "permit deploying without SSO configured", false)
  .option("--allow-disabled-audit", "permit deploying with audit.enabled: false", false)
  .option("-y, --yes", "skip the config-diff confirmation", false)
  .option(
    "--local-build",
    "build with the local Docker daemon instead of Fly's remote builder (fly only)",
    false,
  )
  .option("--destroy", "tear down the deployed app", false)
  .option("--show-secrets", "print credentials in full instead of masked", false)
  .action(async (o) => {
    const { theme, json, quiet } = ui();
    await runDeploy(o.dir, {
      allowLocalLogin: o.allowLocalLogin,
      allowDisabledAudit: o.allowDisabledAudit,
      yes: o.yes,
      localBuild: o.localBuild,
      destroy: o.destroy,
      theme,
      showSecrets: o.showSecrets,
      json,
      quiet,
    });
  });

// Only parse argv when run as a binary, not when imported by tests. The shipped bundle is CommonJS
// (tsup.config.ts, bin dist/index.cjs), so `require.main` is the only check that can ever be true —
// an `import.meta.url` fallback is empty under a cjs build and warns at every build.
if (typeof require !== "undefined" && require.main === module) {
  // Before argv is parsed, so it covers `--help`, `--version`, a bare `warehousd` and an unknown
  // command as well as every real one — and so it is genuinely the first thing printed. That means
  // reading the two flags that affect it straight from argv rather than from program.opts().
  //
  // stderr, unconditionally: not suppressed by `--quiet` or `--json`, because it costs stdout
  // nothing. `status --json | jq` still parses and `start 2>/dev/null` still prints the summary
  // alone. resolveTheme handles NO_COLOR, TERM=dumb and the absence of a TTY, so a piped run is
  // plain text.
  const notice = rcNotice(
    version,
    resolveTheme({
      isTTY: Boolean(process.stderr.isTTY),
      env: process.env,
      noColor: process.argv.includes("--no-color"),
      json: process.argv.includes("--json"),
    }),
  );
  // Opened by a blank line so it clears the shell prompt rather than colliding with it. What
  // follows brings its own top spacing — the wordmark, or a panel, which already opens with one.
  if (notice) process.stderr.write(`\n${notice}\n`);

  // Rejections have to be handled here or not at all: `parseAsync` is the last statement, so an
  // unhandled one printed a stack trace at a user who wanted a message and an exit code.
  program.parseAsync().catch((err: unknown) => {
    // The same theme the notice above resolved. Built again rather than hoisted because a failure
    // during `parseAsync` may come from a command that never reached `ui()`.
    const theme = resolveTheme({
      isTTY: Boolean(process.stderr.isTTY),
      env: process.env,
      noColor: process.argv.includes("--no-color"),
      json: process.argv.includes("--json"),
    });
    // A refusal to prompt is already a finished sentence naming the flag to pass; running it
    // through the Docker translator would only add a hint that does not apply. It still gets the
    // glyph and the indent — that is presentation, not translation.
    if (err instanceof NonInteractiveError) {
      process.stderr.write(`\n${formatExplained({ title: err.message }, theme)}\n\n`);
      process.exit(1);
    }
    const explained = explain(err);
    process.stderr.write(`\n${formatExplained(explained, theme)}\n\n`);
    if (globals().verbose && err instanceof Error && err.stack) {
      process.stderr.write(`\n${err.stack}\n`);
    }
    process.exit(1);
  });
}
