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
// **Every human run is one frame.** `┌ warehousd <command>` at the top, the rail down the side,
// and `└ <what to do next>` at the bottom — see ui/frame.ts. The frame and everything hanging from
// it go to **stdout**, because they are the result; the reporter's step lines go to **stderr**,
// because they are narration. That split is what keeps `warehousd start --json | jq` parseable and
// `warehousd start 2>/dev/null` useful, and off a terminal there is no frame at all.
//
// tsup's entry is this file, emitted as dist/index.cjs so the bin path is unchanged.

import { Command } from "commander";
import { resolve, basename } from "node:path";
import { DEPLOY_TARGET_IDS, DB_PROVIDER_IDS, dbProviders } from "@warehousd/broker";
import { dbHosts, hostFor, localHosts } from "./db/hosts";
import { targets } from "./deploy/targets";
import { ensureToolsFor } from "./init-tools";
import { resolveDbUrl, tryResolveDbUrl, runApply, runSeed, runIndex, runEmbed } from "./index";
import { buildPlan, renderPlan, planOutro, writeMigration, migrationStatus } from "./migrate";
import { runInit, initDefaults, PROD_DB_IDS } from "./init";
import {
  runImportMap,
  runImportRun,
  runImportValidate,
  formatMapResult,
  formatValidateResult,
  mapHeadline,
  mapNotes,
  validateHeadline,
} from "./import";
import { runStart } from "./start";
import { runStop } from "./stop";
import { runStatus } from "./status";
import { runDeploy } from "./deploy";
import { formatOutputs } from "./outputs";
import { ensureState } from "./state";
import { setVerbose } from "./verbose";
import { runDoctor } from "./preflight";
import { runLogs, resolveLogTarget } from "./commands/logs";
import { runOpen, type Target } from "./commands/open";
import { collectSecrets, secretsJson } from "./commands/secrets";
import {
  runPlatformKeyCreate,
  runPlatformKeyList,
  runPlatformKeyRevoke,
  PlatformDisabledError,
} from "./commands/platform-key";
import { resolveTheme, type Theme } from "./ui/theme";
import { rcNoticeBlock } from "./ui/rc-notice";
import { initIntro } from "./ui/brand";
import { createStdReporter } from "./ui/reporter";
import {
  renderStatus,
  renderChecks,
  renderFields,
  renderSuccess,
  initNextSteps,
  docsOutro,
  DOCS_URL,
} from "./ui/render";
import {
  frameOpen,
  labelled,
  openFrame,
  prose,
  rail,
  railDone,
  railFail,
  railLine,
  railWarn,
} from "./ui/frame";
import { helpScreen } from "./ui/help";
import { isInteractive, promptInit, NonInteractiveError, type InitAnswers } from "./ui/prompt";
import { explain, formatExplained, errorOutro } from "./ui/errors";

// WAREHOUSD_CLI_VERSION is defined by tsup at build time; fallback for source runs.
declare const WAREHOUSD_CLI_VERSION: string | undefined;

// Hoisted because two things read it now: `--version`, and the release-candidate notice below,
// which prints only while this is a prerelease. The fallback is one too, so a source run says it.
const version = typeof WAREHOUSD_CLI_VERSION !== "undefined" ? WAREHOUSD_CLI_VERSION : "0.0.0-dev";

/**
 * Which command is running, for the error handler's `└` line.
 *
 * Set by `ui()`, which every action calls first. A failure before any action reaches it — an
 * unknown flag, a refusal to prompt — leaves it null and the outro says "try again" instead of
 * naming a command it cannot know.
 */
let currentCommand: string | null = null;

/**
 * Commander's stock help formatter, kept so the per-command screens can still use it.
 *
 * Taken from a throwaway command rather than imported: `Help` is not on commander's public export
 * surface, and `createHelp()` on a fresh Command is the documented way to reach the default.
 */
const DEFAULT_HELP = new Command().createHelp();

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
  // Commander's own screen is every command in alphabetical order followed by every global flag,
  // which answers "what exists" rather than "what do I type first". ui/help.ts answers the second.
  //
  // Only for the root. `configureHelp` is inherited by every subcommand, so returning the grouped
  // screen unconditionally made `warehousd start --help` print the list of commands instead of
  // start's own flags — and the screen's own last line promises the opposite.
  .configureHelp({
    formatHelp: (cmd, helper) =>
      cmd === program ? `${helpScreen(helpTheme())}\n` : DEFAULT_HELP.formatHelp(cmd, helper),
  });

/** The theme the help screen is drawn with. Resolved from stdout, which is where it lands. */
function helpTheme(): Theme {
  return resolveTheme({
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
    noColor: process.argv.includes("--no-color"),
    json: process.argv.includes("--json"),
  });
}

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

/**
 * Everything an action needs, and the frame it draws in.
 *
 * `title` is the frame's opening line and defaults to the command's own name. `init` passes an
 * empty one: it opens on a welcome instead (ui/brand.ts), because it is the one command whose
 * reader may never have seen the product.
 */
function ui(command: string, title: string | ((t: Theme) => string) = `warehousd ${command}`) {
  currentCommand = command;
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
  return {
    ...g,
    theme,
    reporter,
    frame: openFrame(typeof title === "function" ? title(theme) : title, theme, {
      json: g.json,
      quiet: g.quiet,
    }),
  };
}

/**
 * The machine-readable form, when it was asked for. Always stdout — this is the product.
 *
 * `--quiet` never suppresses it: a caller that asked for a payload and got silence would have no
 * way to tell success from failure except the exit code, which is the thing `--json` exists to
 * improve on.
 */
function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
    // `init` opens on a welcome rather than on its own command name: it is the one command whose
    // reader may never have seen the product, and the frame is where that gets said.
    const { reporter, theme, json, quiet, frame } = ui("init", "");
    const intro = initIntro({
      theme,
      isTTY: Boolean(process.stdout.isTTY),
      quiet,
      json,
      columns: process.stdout.columns,
    });
    if (intro) process.stdout.write(`${intro}\n`);

    const { defaults, fromFlags } = initDefaults({
      project: basename(resolve(o.dir)) || "my-app",
      target: o.target,
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
    const answers = interactive
      ? await promptInit(defaults, { theme })
      : fromFlags
        ? defaults
        : null;
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
      emitJson(r);
      return;
    }
    // The files still narrate on stderr as they happen; everything below is the summary, and it is
    // the product, so it goes to stdout. The spacer is what separates them from whatever the
    // wizard last said — a clack answer, or the intro when there was nobody to ask.
    process.stderr.write(`${railLine("", theme)}\n`);
    for (const f of r.created) reporter.step("Writing", f, `created ${f}`).done();
    for (const f of r.skipped) reporter.step("Keeping", f, `kept ${f}`).done("already exists");
    for (const u of r.unreadable ?? []) reporter.warn(`${u.file}: ${u.reason}`);

    frame.block(
      renderSuccess({
        headline: labelled(theme.i.ready, "Project ready"),
        theme,
        sections: [{ fields: initSummary(answers, r) }],
      }),
    );

    // Deny-by-default is a guess about a column NAME, never a reading of the data, and saying so is
    // the difference between a safe scaffold and one somebody trusts.
    const closed = (r.inferred ?? []).flatMap((c) => c.fields.filter((f) => f.closedBecause));
    if (closed.length > 0) {
      frame.block(
        railWarn(
          [
            `${closed.length} field(s) are closed by default. Each posture is a guess from a`,
            "column name, not a reading of your data — review warehousd.yml before you",
            "apply it.",
          ],
          theme,
        ),
      );
    }

    frame.block(rail(initNextSteps(theme), theme));
    frame.block(rail([`${labelled(theme.i.docs, "Docs")}  ${theme.c.cyan(DOCS_URL)}`], theme));
    frame.close("Run `warehousd start` to bring your project up.");
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
    const { reporter, theme, json, frame } = ui("start");
    const began = Date.now();
    const outputs = await runStart(o.dir, { seed: Number(o.seed), reporter });
    const st = ensureState(o.dir);

    if (json) {
      // The machine contract keeps full values: a caller that asked for JSON asked for the secret.
      emitJson(outputs);
      return;
    }
    frame.block(
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
    frame.close(docsOutro(theme));
  });
program
  .command("apply")
  .description("apply config changes to a running stack, without a restart")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .action(async (o) => {
    const { reporter, theme, json, frame } = ui("apply");
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runApply(o.dir, db, { reporter });
    if (json) {
      emitJson({ applied: true, ...r });
      return;
    }
    for (const m of r.migrated) reporter.step("Migration", m, `Migration ${m} applied`).done();
    if (r.rebuilt.length) reporter.step("Rebuilding", r.rebuilt.join(", "), "Rebuilt").done();
    // A rebuilt synth table is empty until the generator runs again. Saying so is the difference
    // between "apply worked" and an operator wondering where their dev data went.
    if (r.rebuilt.length) {
      frame.block(
        railWarn(
          [
            prose("A rebuilt collection is empty until you run `warehousd seed`", theme),
            "or import data into it.",
          ],
          theme,
        ),
      );
    }
    frame.close(
      r.migrated.length + r.rebuilt.length === 0
        ? "Nothing needed changing — edit warehousd.yml, then re-run."
        : "Applied to the running stack — no restart needed.",
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
    const { theme, json, frame } = ui("migrate plan");
    // No `resolveDbUrl` throw here: a plan from the last deploy snapshot is still worth printing
    // when there is no database to reach, which is the normal case before a deploy.
    const db = tryResolveDbUrl(o.dir, o.db);
    const plan = await buildPlan(o.dir, db);
    if (json) {
      emitJson(plan);
      return;
    }
    frame.block(renderPlan(plan, theme));
    frame.close(planOutro(plan));
  });
migrate
  .command("generate")
  .description("write the pending changes as a reviewable SQL migration")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("-n, --name <slug>", "name for the migration file", "schema-change")
  .action(async (o) => {
    const { theme, json, frame } = ui("migrate generate");
    const db = tryResolveDbUrl(o.dir, o.db);
    const plan = await buildPlan(o.dir, db);
    const blocking = plan.changes.filter((c) => c.destructive);
    if (blocking.length === 0) {
      if (json) {
        emitJson({ written: null, changes: [] });
        return;
      }
      frame.block(railDone(["Nothing to migrate — no change would destroy data."], theme));
      frame.close("`warehousd apply` applies the rest without a migration.");
      return;
    }
    const path = writeMigration(o.dir, plan.changes, o.name);
    const review = blocking.filter((c) => c.reviewRequired).length;
    if (json) {
      emitJson({ written: path, changes: blocking, reviewRequired: review });
      return;
    }
    frame.block(railDone([`Wrote ${theme.c.cyan(path)}`], theme));
    if (review > 0) {
      frame.block(
        railWarn(
          [
            `${review} statement(s) are commented out pending your review — they would`,
            "destroy live data if run as-is.",
          ],
          theme,
        ),
      );
      frame.close("Review the file, then `warehousd apply` runs it.");
      return;
    }
    frame.block(railDone(["Every statement is lossless and ready to run."], theme));
    frame.close("`warehousd apply` runs it.");
  });
migrate
  .command("status")
  .description("which project migrations have been applied")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .action(async (o) => {
    const { theme, json, frame } = ui("migrate status");
    const rows = await migrationStatus(o.dir, resolveDbUrl(o.dir, o.db));
    if (json) {
      emitJson(rows);
      return;
    }
    if (rows.length === 0) {
      frame.block(railDone(["No migrations in this project."], theme));
      frame.close("`warehousd migrate generate` writes the first one.");
      return;
    }
    const width = Math.max(...rows.map((r) => r.version.length));
    frame.block(
      rows
        .map((r) =>
          r.state === "applied"
            ? railDone([`${r.version.padEnd(width)}   ${theme.c.dim("applied")}`], theme)
            : railWarn([`${r.version.padEnd(width)}   ${theme.c.dim(r.state)}`], theme),
        )
        .join("\n"),
    );
    const pending = rows.filter((r) => r.state !== "applied").length;
    frame.close(
      pending === 0
        ? "Everything applied — nothing pending."
        : `${pending} pending — \`warehousd apply\` runs ${pending === 1 ? "it" : "them"}.`,
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
    const { reporter, json, frame } = ui("seed");
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runSeed(o.dir, db, Number(o.seed), { reindex: o.reindex, reporter });
    if (json) {
      emitJson({ seeded: true, seed: r.seed, reindexed: r.reindexed });
      return;
    }
    frame.close("`warehousd open` shows the new data in the admin UI.");
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
    const { reporter, json, frame } = ui(`index ${collection}`);
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runIndex(o.dir, db, collection, {
      env: o.env,
      source: o.source,
      embed: o.embed,
      reporter,
    });
    if (json) {
      emitJson(r);
      return;
    }
    frame.close(
      r.indexed === 0
        ? "Nothing had changed — every file was already indexed."
        : "`warehousd embed` fills the embeddings for what changed.",
    );
  });
program
  .command("embed [collection]")
  .description("fill embeddings for file collections (resumable)")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("--env <env>", "dev|live", "dev")
  .action(async (collection, o) => {
    const { reporter, json, frame } = ui(collection ? `embed ${collection}` : "embed");
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runEmbed(o.dir, db, { collection, env: o.env, reporter });
    if (json) {
      emitJson(r);
      return;
    }
    frame.close("Resumable — re-running continues where this stopped.");
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
    // The proposal is the product and goes to stdout untouched — people pipe it into
    // warehousd.yml — so this command's frame narrates around it on **stderr** instead.
    const { theme, json, quiet } = ui(`import map ${file}`, "");
    const frame = openFrame(`warehousd import map ${file}`, theme, {
      json,
      quiet,
      stream: "err",
    });
    const r = runImportMap(o.dir, file, {
      collection: o.collection,
      sheet: o.sheet,
      headerRow: Number(o.headerRow),
    });
    if (json) {
      emitJson(r);
      return;
    }
    frame.block(railDone([mapHeadline(r)], theme));
    const notes = mapNotes(r);
    if (notes.length) frame.block(rail(notes, theme));
    const yaml = formatMapResult(r);
    frame.close(
      yaml
        ? "Paste the block below into warehousd.yml, then review each posture."
        : "Nothing to paste — the collection already matches the file.",
    );
    if (yaml) process.stdout.write(`${yaml}\n`);
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
    const { reporter, theme, json, frame } = ui(`import validate ${collection} ${file}`);
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
    if (json) {
      emitJson(r);
      process.exit(r.ok ? 0 : 1);
    }
    const body = formatValidateResult(r).split("\n");
    frame.block(
      r.ok
        ? railDone([validateHeadline(r), ...body.map((l) => theme.c.dim(l))], theme)
        : railFail([validateHeadline(r), ...body], theme),
    );
    frame.close(
      r.ok
        ? `\`warehousd import run ${collection} ${file}\` loads it.`
        : "Fix the rows above, then re-run.",
    );
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
    const { reporter, theme, json, frame } = ui(`import run ${collection} ${file}`);
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runImportRun(o.dir, db, collection, file, {
      mode: o.mode,
      dryRun: o.dryRun,
      sheet: o.sheet,
      headerRow: Number(o.headerRow),
      reporter,
    });
    if (json) {
      emitJson(r);
      process.exit(r.ok ? 0 : 1);
    }
    if (!r.ok) {
      frame.block(
        railFail(
          [
            `${collection} refused the file`,
            ...formatValidateResult({
              ok: false,
              layer: "live",
              rows: 0,
              collection,
              summary: r.summary,
              blindSpot: null,
            }).split("\n"),
          ],
          theme,
        ),
      );
      frame.close("Fix the rows above, then re-run.");
      process.exit(1);
    }
    const n = (x: number) => x.toLocaleString("en-US");
    frame.block(
      renderSuccess({
        // A dry run rolls everything back, so calling it an import would be a lie about the state
        // of the database — see runImportRun.
        headline: r.dryRun ? "Preview complete" : `Loaded into ${collection}`,
        theme,
        sections: [
          {
            fields: [
              { label: labelled(theme.i.data, "Added"), value: n(r.inserted) },
              { label: labelled(theme.i.data, "Revised"), value: n(r.updated) },
              { label: labelled(theme.i.data, "Deleted"), value: n(r.deleted) },
            ],
          },
        ],
      }),
    );
    if (r.dryRun) {
      frame.block(railWarn(["Nothing was written — every statement was rolled back."], theme));
      frame.close("Re-run without --dry-run to load it.");
      return;
    }
    frame.close("`warehousd open` shows them in the admin UI.");
  });

program
  .command("stop")
  .description("stop the containers, keeping your data")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--destroy", "remove volume and data (irreversible)")
  .option("-y, --yes", "skip confirmation for --destroy")
  .action(async (o) => {
    const { theme, json, frame } = ui("stop");
    await runStop(o.dir, { destroy: o.destroy, yes: o.yes });
    if (json) {
      emitJson({ stopped: true, destroyed: Boolean(o.destroy) });
      return;
    }
    frame.block(
      railDone(
        [theme.c.bold(o.destroy ? "Containers, volume and network removed" : "Containers stopped")],
        theme,
      ),
    );
    // Data surviving a `stop` is the difference between the two runs, and the one thing somebody
    // wants confirmed before they walk away.
    if (o.destroy) {
      frame.block(railWarn(["The volume is gone — every document in it went with it."], theme));
      frame.close("`warehousd start` begins from an empty database.");
      return;
    }
    frame.close("Your data is untouched — `warehousd start` brings it back.");
  });
program
  .command("status")
  .description("is this project's stack up, and on which URLs")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--show-secrets", "print credentials in full instead of masked", false)
  .action(async (o) => {
    const { theme, json, frame } = ui("status");
    const result = await runStatus(o.dir);
    if (json) {
      emitJson({
        healthy: result.healthy,
        project: result.project,
        containers: result.containers,
        outputs: result.outputs,
      });
      process.exit(result.healthy ? 0 : 1);
    }
    if (result.containers.length === 0) {
      frame.block(railFail([theme.c.bold("No containers for this project.")], theme));
      frame.close("`warehousd start` brings the stack up.");
    } else {
      frame.block(
        renderStatus({
          project: result.project,
          healthy: result.healthy,
          containers: result.containers,
          outputs: result.outputs,
          theme,
          showSecrets: o.showSecrets,
        }),
      );
      frame.close(
        result.healthy
          ? "`warehousd logs -f` follows the server logs."
          : "`warehousd logs` usually says why.",
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
    // One frame across both phases: a restart is one thing that happened, not two commands.
    const { reporter, theme, json, frame } = ui("restart");
    const began = Date.now();
    await runStop(o.dir, { yes: true });
    reporter.step("Stopping", "the containers", "Containers stopped").done();
    const outputs = await runStart(o.dir, { seed: Number(o.seed), reporter });
    const st = ensureState(o.dir);
    if (json) {
      emitJson(outputs);
      return;
    }
    frame.block(
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
    frame.close(docsOutro(theme));
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
    // No frame around a raw stream — see below — so this one opens on nothing.
    const { theme, json } = ui("logs", "");
    // A stream has no last element, so there is no object to close. Refusing beats accepting the
    // flag and quietly emitting raw text that no parser asked for.
    if (json && o.follow) {
      throw new Error("--json cannot be combined with --follow: a stream has no end to serialise.");
    }
    // No frame around a raw stream: a rail down the side of the log lines would corrupt every
    // grep and every pipe. A header on **stderr** is the whole decoration this command gets.
    if (!json) {
      const target = resolveLogTarget(o.dir, o.service);
      const header = frameOpen(
        `warehousd logs — ${target}, ${o.follow ? "following" : `last ${Number(o.tail)} lines`}`,
        theme,
      );
      if (header) process.stderr.write(`${header}\n\n`);
    }
    const out = await runLogs(o.dir, {
      follow: o.follow,
      tail: Number(o.tail),
      service: o.service,
    });
    if (out === null) return; // --follow already streamed it
    if (json) {
      emitJson({ service: o.service, lines: out === "" ? [] : out.split("\n") });
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
    const { theme, json, frame } = ui(target ? `open ${target}` : "open");
    const r = runOpen(o.dir, t);
    if (json) {
      emitJson(r);
      return;
    }
    if (r.opened) {
      frame.block(railDone([`Opened ${theme.c.cyan(r.url)} in your browser`], theme));
      frame.close("`warehousd open mcp` and `warehousd open api` open the others.");
      return;
    }
    // Nothing to launch: the URL is the product, so it goes to stdout on a line of its own where
    // it can be copied or piped.
    frame.block(railFail(["No browser opener found on this platform."], theme));
    frame.close("The URL is on the line below — open it yourself.");
    process.stdout.write(`${r.url}\n`);
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
    // The icon trails the name here rather than leading it, unlike a field label: every frame in
    // the CLI opens on `warehousd <command>`, and putting a glyph in front of one of them breaks
    // the one column the eye is scanning for.
    const { theme, json, frame } = ui("doctor", (t) => `warehousd doctor ${t.i.doctor}`.trimEnd());
    const result = await runDoctor(o.dir, { deploy: o.deploy });
    if (json) {
      emitJson(result);
      process.exit(result.ok ? 0 : 1);
    }
    frame.block(renderChecks(result.checks, theme));
    const problems = result.checks.filter((c) => !c.ok).length;
    frame.close(
      problems === 0
        ? "Everything checks out — `warehousd start` is safe to run."
        : `${problems} ${problems === 1 ? "problem" : "problems"} found — fix ` +
            `${problems === 1 ? "it" : "them"}, then re-run \`warehousd doctor\`.`,
    );
    process.exit(result.ok ? 0 : 1);
  });
program
  .command("secrets")
  .description("show the generated credentials, masked unless --show")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--show", "print them in full", false)
  .action((o) => {
    const { theme, json, frame } = ui("secrets");
    if (json) {
      emitJson(secretsJson(o.dir));
      return;
    }
    const icons = { secret: theme.i.secrets, login: theme.i.login, database: theme.i.database };
    frame.block(
      renderFields({
        sections: [
          {
            fields: collectSecrets(o.dir).map((e) => ({
              label: labelled(icons[e.kind], e.label),
              value: e.value,
              secret: e.secret,
            })),
          },
        ],
        theme,
        showSecrets: o.show,
      }),
    );
    frame.close(
      o.show
        ? "Shown in full — anything on this screen is a live credential."
        : "Masked — `--show` reveals them, `--json` is for scripts.",
    );
  });
// A refusal here is not the generic error path: `workspaces.enabled: false` is not a mistake, it
// is the deployment's own default, and the fix is always the same two commands — so it is said
// once, here, rather than routed through explain()/errorOutro(), which cannot know it.
function platformDisabledOutro(frame: ReturnType<typeof ui>["frame"], theme: Theme): never {
  frame.block(railFail(["Platform key management is disabled."], theme));
  frame.close("Set `workspaces.enabled: true` in warehousd.yml, then run `warehousd apply`.");
  process.exit(1);
}
const platformKey = program
  .command("platform-key")
  .description("manage keys for the workspace provisioning API (/v1/platform)");
platformKey
  .command("create")
  .description("mint a platform key")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .requiredOption("--label <label>", "what this key is for")
  .option("--workspaces <ids>", "comma-separated workspace ids this key may manage")
  .option("--all-workspaces", "this key may reach every workspace on the deployment", false)
  .option("--days <n>", "lifetime in days", "90")
  .action(async (o) => {
    const { theme, json, frame } = ui("platform-key create");
    if (!o.allWorkspaces && !o.workspaces) {
      throw new Error(
        "Pass --workspaces <ids> to scope this key, or --all-workspaces for every tenant.",
      );
    }
    const db = resolveDbUrl(o.dir, o.db);
    try {
      const r = await runPlatformKeyCreate(o.dir, db, {
        label: o.label,
        allWorkspaces: Boolean(o.allWorkspaces),
        workspaces: o.workspaces
          ? (o.workspaces
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean) as string[])
          : undefined,
        days: Number(o.days),
      });
      if (json) {
        emitJson({
          id: r.id,
          secret: r.secret,
          managedWorkspaces: r.managedWorkspaces,
          expiresAt: r.expiresAt.toISOString(),
        });
        return;
      }
      if (r.managedWorkspaces === null) {
        frame.block(
          railWarn(
            ["This key can reach EVERY workspace on this deployment — store it accordingly."],
            theme,
          ),
        );
      }
      frame.block(railDone([`Key id     ${r.id}`, `Secret     ${theme.c.bold(r.secret)}`], theme));
      frame.close(
        "Shown once — store it now. `warehousd platform-key list` shows the id again, never the secret.",
      );
    } catch (err) {
      if (err instanceof PlatformDisabledError) platformDisabledOutro(frame, theme);
      throw err;
    }
  });
platformKey
  .command("list")
  .description("list platform keys — never their secrets")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .action(async (o) => {
    const { theme, json, frame } = ui("platform-key list");
    const db = resolveDbUrl(o.dir, o.db);
    try {
      const keys = await runPlatformKeyList(o.dir, db);
      if (json) {
        emitJson(
          keys.map((k) => ({
            ...k,
            createdAt: k.createdAt.toISOString(),
            expiresAt: k.expiresAt.toISOString(),
            lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
            revokedAt: k.revokedAt?.toISOString() ?? null,
          })),
        );
        return;
      }
      if (keys.length === 0) {
        frame.block(railDone(["No platform keys yet."], theme));
        frame.close("`warehousd platform-key create` mints the first one.");
        return;
      }
      frame.block(
        rail(
          keys.map((k) => {
            const scope =
              k.managedWorkspaces === null
                ? "all workspaces"
                : k.managedWorkspaces.join(", ") || "none";
            const status = k.revokedAt
              ? "revoked"
              : k.expiresAt < new Date()
                ? "expired"
                : "active";
            return `${k.id}  ${k.label}  ${theme.c.dim(`${scope} · ${status}`)}`;
          }),
          theme,
        ),
      );
      frame.close("`warehousd platform-key revoke <id>` retires one.");
    } catch (err) {
      if (err instanceof PlatformDisabledError) platformDisabledOutro(frame, theme);
      throw err;
    }
  });
platformKey
  .command("revoke <id>")
  .description("revoke a platform key")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .action(async (id, o) => {
    const { theme, json, frame } = ui(`platform-key revoke ${id}`);
    const db = resolveDbUrl(o.dir, o.db);
    try {
      const revoked = await runPlatformKeyRevoke(o.dir, db, id);
      if (json) {
        emitJson({ id, revoked });
        return;
      }
      if (!revoked) {
        frame.block(railFail([`No unrevoked key ${id}.`], theme));
        frame.close("`warehousd platform-key list` shows what exists.");
        process.exit(1);
      }
      frame.block(railDone([`Revoked ${id}`], theme));
      frame.close("Any request already using it is refused from now on.");
    } catch (err) {
      if (err instanceof PlatformDisabledError) platformDisabledOutro(frame, theme);
      throw err;
    }
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
    const { theme, json, quiet, frame } = ui("deploy");
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
      frame,
    });
  });

/**
 * The global flags, on every per-command `--help`.
 *
 * They live on the root command, and commander does not repeat a parent's options in a
 * subcommand's help — so `warehousd start --help` listed three flags and none of the four that
 * work everywhere. The discovery screen deliberately leaves them out and points here instead, so
 * here is where they have to be.
 */
const GLOBAL_FLAGS = `
Global options:
  --json         machine-readable output on stdout
  -q, --quiet    only errors and results
  --no-color     disable colour (also honours NO_COLOR)
  --verbose      echo every command warehousd shells out to`;

for (const command of allCommands(program)) command.addHelpText("after", GLOBAL_FLAGS);

/** Every command under the root, at any depth — `migrate plan` and `import run` included. */
function allCommands(root: Command): Command[] {
  return root.commands.flatMap((c) => [c, ...allCommands(c)]);
}

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
  // The blank line above *and* below is `rcNoticeBlock`'s, not this call site's. Above so it clears
  // the shell prompt; below so whatever follows — a frame, a raw log stream, a version number —
  // never lands hard against it.
  const notice = rcNoticeBlock(
    version,
    resolveTheme({
      isTTY: Boolean(process.stderr.isTTY),
      env: process.env,
      noColor: process.argv.includes("--no-color"),
      json: process.argv.includes("--json"),
    }),
  );
  if (notice) process.stderr.write(notice);

  // A bare `warehousd` is somebody who does not yet know what to type, which is the one moment the
  // grouped screen exists for. Commander's default is the error "missing command".
  if (process.argv.length <= 2) {
    process.stdout.write(`${helpScreen(helpTheme())}\n`);
    process.exit(0);
  }

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
    // glyph and the rail — that is presentation, not translation.
    const explained = err instanceof NonInteractiveError ? { title: err.message } : explain(err);
    // The spacer keeps the failure from landing hard against whatever came before it — the frame's
    // own opening line, or the release-candidate notice when nothing had opened one.
    process.stderr.write(`${railLine("", theme)}\n${formatExplained(explained, theme)}\n`);
    const outro = errorOutro(explained, currentCommand, theme);
    // The `└` always says what to do, so a failure never ends on a bare stack of red.
    process.stderr.write(outro === null ? "\n" : `${railLine("", theme)}\n${outro}\n\n`);
    if (globals().verbose && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n\n`);
    }
    process.exit(1);
  });
}
