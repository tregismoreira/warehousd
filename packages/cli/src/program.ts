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
import { resolveDbUrl, runApply, runSeed, runIndex, runEmbed } from "./index";
import { runInit } from "./init";
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
import { resolveTheme } from "./ui/theme";
import { createStdReporter } from "./ui/reporter";
import { renderStatus, renderChecks, renderPanel } from "./ui/render";
import { isInteractive, promptInit, NonInteractiveError } from "./ui/prompt";
import { explain, formatExplained } from "./ui/errors";

// WAREHOUSD_CLI_VERSION is defined by tsup at build time; fallback for source runs.
declare const WAREHOUSD_CLI_VERSION: string | undefined;

const program = new Command();
program
  .name("warehousd")
  .description("warehousd CLI")
  .version(typeof WAREHOUSD_CLI_VERSION !== "undefined" ? WAREHOUSD_CLI_VERSION : "0.0.0-dev")
  // `--help` is on every command already; the `help [command]` subcommand only pads the list.
  .helpCommand(false)
  // clig.dev: suggest, do not correct. Commander gives both for free and neither was switched on.
  .showHelpAfterError("(run `warehousd --help` for the full list)")
  .showSuggestionAfterError(true)
  .option("--json", "machine-readable output on stdout", false)
  .option("-q, --quiet", "only errors and results", false)
  .option("--no-color", "disable colour (also honours NO_COLOR)")
  .option("--verbose", "echo every docker and flyctl command", false)
  .addHelpText(
    "after",
    `
Examples:
  $ warehousd init                 scaffold warehousd.yml here
  $ warehousd start                bring the stack up and print its URLs
  $ warehousd status --json | jq   machine-readable health
  $ warehousd logs --follow        tail the server container
  $ warehousd doctor               check Docker, image, ports and config
  $ warehousd secrets --show       reveal the masked credentials
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
  .description("scaffold warehousd.yml in this directory")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--force", "overwrite an existing warehousd.yml")
  .option("--no-input", "never prompt; write the default template")
  .action(async (o) => {
    const { reporter, json } = ui();
    // The wizard only runs where there is somebody to answer it. Piped, in CI, under --json or
    // --no-input, `init` writes exactly the template it always wrote.
    const interactive = o.input !== false && !json && isInteractive();
    const answers = interactive
      ? await promptInit({
          project: basename(resolve(o.dir)) || "my-app",
          port: 8722,
          managed: true,
        })
      : null;
    if (interactive && !answers) {
      reporter.fail("Cancelled.");
      process.exit(1);
    }

    const r = await runInit(o.dir, {
      force: o.force,
      ...(answers ? { answers } : {}),
    });
    if (json) {
      emit(r, "");
      return;
    }
    for (const f of r.created) reporter.step("created", f).done();
    for (const f of r.skipped) reporter.step("skipped", `${f} (already exists)`).done();
    reporter.note("Next: warehousd start");
  });
program
  .command("start")
  .description("start the server and its database, then print the URLs")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("-s, --seed <n>", "synthetic seed", "42")
  .option("--show-secrets", "print credentials in full instead of masked", false)
  .action(async (o) => {
    const { reporter, theme, json } = ui();
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
  .description("re-apply warehousd.yml without a restart")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .action(async (o) => {
    ui();
    const db = resolveDbUrl(o.dir, o.db);
    await runApply(o.dir, db);
    emit({ applied: true }, "applied");
  });
program
  .command("seed")
  .description("regenerate synthetic data, then re-index file collections")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("-s, --seed <n>", "seed", "42")
  .option("--no-reindex", "leave file collections as they are")
  .action(async (o) => {
    ui();
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runSeed(o.dir, db, Number(o.seed), { reindex: o.reindex });
    emit(
      { seeded: true, seed: r.seed, reindexed: r.reindexed },
      r.reindexed.length ? `seeded, re-indexed ${r.reindexed.join(", ")}` : "seeded",
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
    ui();
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runIndex(o.dir, db, collection, {
      env: o.env,
      source: o.source,
      embed: o.embed,
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
    ui();
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runEmbed(o.dir, db, { collection, env: o.env });
    emit(r, `embedded=${r.embedded} collections=${r.collections.join(",")}`);
  });
program
  .command("stop")
  .description("stop the containers, keeping data")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--destroy", "remove volume and data (irreversible)")
  .option("-y, --yes", "skip confirmation for --destroy")
  .action(async (o) => {
    const { reporter, json } = ui();
    await runStop(o.dir, { destroy: o.destroy, yes: o.yes });
    if (json) emit({ stopped: true, destroyed: Boolean(o.destroy) }, "");
    else
      reporter.step("stopped", o.destroy ? "containers, volume and network" : "containers").done();
  });
program
  .command("status")
  .description("health of this project's stack")
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
      process.stdout.write("No containers for this project. Run `warehousd start`.\n");
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
    const { reporter, theme, json } = ui();
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
  .action(async (o) => {
    const { theme, json } = ui();
    const result = await runDoctor(o.dir);
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`\n${renderChecks(result.checks, theme)}\n\n`);
    }
    process.exit(result.ok ? 0 : 1);
  });
program
  .command("secrets")
  .description("the generated credentials, masked unless --show")
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
        ...(o.show ? {} : { footer: "Masked — add --show to reveal, or --json for a script" }),
      })}\n`,
    );
  });
program
  .command("deploy")
  .description("deploy this project to Fly.io, or tear it down with --destroy")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--allow-local-login", "permit deploying without SSO configured", false)
  .option("-y, --yes", "skip the config-diff confirmation", false)
  .option(
    "--local-build",
    "build with the local Docker daemon instead of Fly's remote builder",
    false,
  )
  .option("--destroy", "tear down the deployed app", false)
  .option("--show-secrets", "print credentials in full instead of masked", false)
  .action(async (o) => {
    const { theme, json, quiet } = ui();
    await runDeploy(o.dir, {
      allowLocalLogin: o.allowLocalLogin,
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
  // Rejections have to be handled here or not at all: `parseAsync` is the last statement, so an
  // unhandled one printed a stack trace at a user who wanted a message and an exit code.
  program.parseAsync().catch((err: unknown) => {
    // A refusal to prompt is already a finished sentence naming the flag to pass; running it
    // through the Docker translator would only add a hint that does not apply.
    if (err instanceof NonInteractiveError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    const explained = explain(err);
    process.stderr.write(`${formatExplained(explained)}\n`);
    if (globals().verbose && err instanceof Error && err.stack) {
      process.stderr.write(`\n${err.stack}\n`);
    }
    process.exit(1);
  });
}
