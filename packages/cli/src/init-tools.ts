import { checkTool, offerInstall, type CliTool, type ToolProbe } from "./cli-tools";
import { runtimeFor } from "./containers/runtimes";
import { hostFor } from "./db/hosts";
import { NonInteractiveError, type InitAnswers } from "./ui/prompt";
import type { Reporter } from "./ui/reporter";

/**
 * Make sure every CLI the answers imply is actually on this machine.
 *
 * The step that turns `warehousd init` from a file writer into a setup command. Picking "create
 * the database on Supabase" in a wizard and then discovering four commands later that the Supabase
 * CLI was never installed is the failure this exists to prevent — the check happens while the
 * choice is still fresh, and the offer to fix it happens in the same breath.
 *
 * What it deliberately does not do:
 *
 *   - **Install without consent.** `offerInstall` prompts, or takes `--install-missing` as consent
 *     given in advance. There is no path where picking a menu item runs a package manager.
 *   - **Authenticate.** `supabase login` opens a browser and belongs to the operator. A tool that
 *     is present but logged out is reported with the command that fixes it, and `init` carries on:
 *     scaffolding a warehousd.yml does not need a session, and refusing to write the file over it
 *     would be refusing the thing that was asked for.
 *   - **Block.** Nothing here is fatal. `init` writes the config either way; `warehousd deploy`
 *     runs the same checks again and *that* is the command that refuses, because that is the
 *     command that cannot proceed.
 */
export async function ensureToolsFor(
  answers: InitAnswers,
  opts: {
    reporter: Reporter;
    installMissing?: boolean | undefined;
    interactive?: boolean;
    /**
     * The platform and PATH to answer questions about, defaulting to this machine's. Threaded
     * through because both `checkTool` and `offerInstall` already take one and this was the only
     * layer that did not: without it the outcome depends on what the *host* has installed, so the
     * tests could only assert whichever branch the developer's own machine happened to take. That
     * is how the "warns rather than aborting" test came to pass on macOS and fail on every Linux
     * CI runner — Docker installs via `brew` or `winget` and neither exists there, so the message
     * is the manual-instructions one rather than the `--install-missing` one.
     */
    probe?: ToolProbe | undefined;
  },
): Promise<void> {
  const needed = requiredTools(answers);
  if (needed.length === 0) return;

  for (const tool of needed) {
    const check = checkTool(tool, opts.probe);
    if (check.ok) {
      opts.reporter.step("checked", tool.label).done(check.detail);
      continue;
    }

    // Present but not usable — logged out, or a daemon that is not running. Nothing to install,
    // and the hint is already the one sentence that fixes it.
    if (!check.detail.includes("not found on PATH")) {
      opts.reporter.warn(`${tool.label}: ${check.detail}`);
      continue;
    }

    const step = opts.reporter.step("installing", tool.label);
    try {
      const outcome = await offerInstall(tool, {
        ...(opts.installMissing !== undefined ? { assumeYes: opts.installMissing } : {}),
        ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
        ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
        say: (msg) => opts.reporter.note(msg),
      });
      if (outcome.ok) {
        step.done(outcome.command);
      } else {
        // A refusal, a skip and a failed install all end the same way from here: the operator has
        // one command to run, and `init` is not the command that needs it.
        step.fail();
        opts.reporter.warn(outcome.reason);
      }
    } catch (err: unknown) {
      // `confirm` throws NonInteractiveError off a TTY, and for `offerInstall`'s own callers that
      // refusal is the right outcome — an unattended run must not mutate the machine. Here it is
      // not: `init`'s job is to write a config file, and it can do that whether or not a provider
      // CLI is present. Catching it is what keeps this step advisory, which is what the contract
      // above promises. `warehousd deploy` runs the same check and *that* one refuses.
      if (!(err instanceof NonInteractiveError)) throw err;
      step.fail();
      opts.reporter.warn(err.message);
    }
  }
}

/** Every CLI these answers depend on, in the order the operator will need them. */
export function requiredTools(answers: InitAnswers): CliTool[] {
  const tools: CliTool[] = [];

  // Always: something has to run the containers, whichever database is chosen — the server is one.
  tools.push(runtimeFor(answers.runtime).cli);

  // The local stack, when it is somebody else's.
  const localHost = answers.localDbProvider ? hostFor(answers.localDbProvider) : undefined;
  if (localHost) tools.push(localHost.cli);

  // The production database, when warehousd is going to create it. Not when a url is being
  // attached: that needs no CLI at all, which is the point of the manual path.
  const deployHost =
    answers.deployManaged && answers.dbProvider ? hostFor(answers.dbProvider) : undefined;
  if (deployHost) tools.push(deployHost.cli);

  // Deploy targets are deliberately absent. `init` scaffolds a `deploy:` block that may never be
  // used, and flyctl is checked by `warehousd deploy`'s own pre-flight where it is actually
  // needed. Installing it here would be installing something on a guess.

  // Deduplicated by binary: a project running Supabase both locally and in production names the
  // same CLI twice, and asking twice would be asking twice.
  return tools.filter((tool, i) => tools.findIndex((t) => t.bin === tool.bin) === i);
}
