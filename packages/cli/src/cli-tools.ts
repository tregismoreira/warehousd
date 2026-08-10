import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { confirm } from "./ui/prompt";
import { traceCommand, traceFailure } from "./verbose";

/**
 * One answer to "is the tool this command needs installed, usable, and if not how do we get it?"
 *
 * It was six near-identical `assertX` functions — `assertFly`, `assertRailway`, `assertDocker` and
 * one per database host — each with its own wording for the same three outcomes and its own
 * hardcoded install sentence. Six copies is where the wording drifts, and where a new tool starts
 * by copying whichever one was nearest.
 *
 * The split of responsibility is deliberate: this module decides *whether* a tool is ready and
 * *how* it could be installed. Each tool's own module keeps its `run`/`tryRun` — the stdio rules
 * and the argv redaction are per-CLI facts and do not generalise (see the header comments in
 * fly.ts, railway.ts and docker.ts, which are not the same rules and must not be merged).
 */

// `as const` with an inferred union rather than an enum, per AGENTS.md.
export const PACKAGE_MANAGERS = [
  "brew",
  "winget",
  "scoop",
  "choco",
  "apt-get",
  "dnf",
  "pacman",
  "npm",
] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/**
 * The managers that install system-wide and need root.
 *
 * warehousd never invokes `sudo`. Escalating privileges is not something a scaffolding command
 * should do on somebody's behalf, and a prompt that asks for a password is a prompt people learn
 * to type through. An installer on this list is printed for the operator to run, never executed.
 */
const NEEDS_ROOT: ReadonlySet<PackageManager> = new Set(["apt-get", "dnf", "pacman"]);

/**
 * Which managers to look for, in preference order, on each platform.
 *
 * `npm` is last everywhere and present everywhere: it needs no root, it is already installed
 * (this is a Node CLI), and it is the only fallback that works on a platform none of the others
 * cover. It is last because a native package is better integrated where one exists.
 *
 * The `win32` row is here because it is the correct shape, not because Windows is supported —
 * see docs/roadmap.md. Costing nothing to write down is not the same as a claim that it works.
 */
const MANAGERS_BY_PLATFORM: Partial<Record<NodeJS.Platform, readonly PackageManager[]>> = {
  darwin: ["brew", "npm"],
  linux: ["apt-get", "dnf", "pacman", "npm"],
  win32: ["winget", "scoop", "choco", "npm"],
};

const FALLBACK_MANAGERS: readonly PackageManager[] = ["npm"];

export type Installer = {
  manager: PackageManager;
  /** Everything after the manager's own name: `["install", "supabase/tap/supabase"]`. */
  args: string[];
};

export type CliTool = {
  /** The binary, as it is spelled on PATH. Also the stem of the pre-flight check id. */
  bin: string;
  /** Human name, for a refusal that reads as a sentence. */
  label: string;
  /**
   * Proves the binary exists and runs. Chosen so it works before login and before any daemon is
   * up — `--version`, not a command that talks to a server.
   */
  versionArgs: string[];
  /**
   * Proves the tool is actually usable: logged in, or its daemon answering.
   *
   * One field rather than separate "auth" and "daemon" ones, because from the caller's side they
   * are the same state — installed, not yet usable, one sentence away from being fixed.
   */
  readyArgs?: string[];
  /** That sentence. Required in practice whenever `readyArgs` is set. */
  readyHint?: string;
  docsUrl: string;
  /** In preference order; only ones whose manager is on this machine are ever offered. */
  installers: Installer[];
  /**
   * A route that is not a package manager — Fly's `curl … | sh`, say.
   *
   * Printed alongside the rest and **never executed**: warehousd does not pipe a downloaded
   * script into a shell on somebody's behalf. It is here because dropping it would leave a Linux
   * machine with no brew holding a docs link where it used to have the exact command.
   */
  manualInstall?: string;
};

/**
 * The machine, injected.
 *
 * `exists` and `exec` are seams: `detectManagers` walks PATH with `existsSync`, and `checkTool`
 * shells out. A unit test should be able to describe a machine — "macOS, brew but no npm" —
 * without one of either.
 */
export type ToolProbe = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists?: ((path: string) => boolean) | undefined;
  exec?: ((bin: string, args: string[]) => string) | undefined;
};

const CAPTURED: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

function defaultExec(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf8", stdio: CAPTURED }).trim();
}

// Spelled out rather than `Required<ToolProbe>`: the seams are declared `| undefined` as well as
// optional, and `Required` only strips the `?`, leaving something that still cannot be called.
type ResolvedProbe = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  exec: (bin: string, args: string[]) => string;
};

function resolve(probe?: ToolProbe): ResolvedProbe {
  return {
    platform: probe?.platform ?? process.platform,
    env: probe?.env ?? process.env,
    exists: probe?.exists ?? existsSync,
    exec: probe?.exec ?? defaultExec,
  };
}

/**
 * Is `bin` on PATH?
 *
 * A filesystem walk rather than running the thing, because this is asked about *package managers*
 * — and running `brew` to find out whether brew exists is a second of startup for a question the
 * PATH already answers. `checkTool` below does the opposite for the opposite reason.
 *
 * PATHEXT on win32 is why this is not three lines: a bare `winget` is never a file there.
 */
function onPath(bin: string, probe: ResolvedProbe): boolean {
  // `Path` as well as `PATH`: environment variable names are case-insensitive on Windows and
  // Node preserves whatever casing the parent process used.
  const pathVar = probe.env.PATH ?? probe.env.Path ?? "";
  if (!pathVar) return false;

  const separator = probe.platform === "win32" ? ";" : ":";
  const extensions =
    probe.platform === "win32" ? (probe.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];

  for (const dir of pathVar.split(separator)) {
    if (!dir) continue;
    for (const extension of extensions) {
      if (probe.exists(join(dir, bin + extension))) return true;
    }
  }
  return false;
}

/** Every package manager this machine actually has, in the order we would rather use them. */
export function detectManagers(probe?: ToolProbe): PackageManager[] {
  const resolved = resolve(probe);
  const candidates = MANAGERS_BY_PLATFORM[resolved.platform] ?? FALLBACK_MANAGERS;
  return candidates.filter((manager) => onPath(manager, resolved));
}

export type InstallCommand = {
  /** The binary to run. Split from `args` so executing never has to index into `argv`. */
  manager: PackageManager;
  args: string[];
  /** The whole thing, for printing. */
  argv: string[];
  /** True when running it needs root, which warehousd will not do — print it instead. */
  needsRoot: boolean;
};

/** How this tool would be installed here, or undefined when no manager we know of is present. */
export function installCommand(tool: CliTool, probe?: ToolProbe): InstallCommand | undefined {
  const available = detectManagers(probe);
  for (const installer of tool.installers) {
    if (!available.includes(installer.manager)) continue;
    return {
      manager: installer.manager,
      args: installer.args,
      argv: [installer.manager, ...installer.args],
      needsRoot: NEEDS_ROOT.has(installer.manager),
    };
  }
  return undefined;
}

/**
 * Every install route for this tool, as text — the fallback when no manager is present.
 *
 * `manualInstall` is included here and nowhere near `installCommand`, which is the split that
 * matters: this list is printed, that one is run.
 */
function allInstallCommands(tool: CliTool): string[] {
  const commands = tool.installers.map((installer) =>
    [installer.manager, ...installer.args].join(" "),
  );
  if (tool.manualInstall) commands.push(tool.manualInstall);
  return commands;
}

/**
 * What to say when the tool is not there.
 *
 * Names the one command that would work *here* when we can tell, and every command we know of
 * when we cannot — which is better than a docs link on a machine whose package manager we did
 * not recognise. The link comes last either way, because it is the answer to a different
 * question.
 */
export function missingToolMessage(tool: CliTool, probe?: ToolProbe): string {
  const here = installCommand(tool, probe);
  const commands = here ? [here.argv.join(" ")] : allInstallCommands(tool);
  const how = commands.length === 1 ? commands[0] : `one of: ${commands.join(", ")}`;
  return `${tool.bin} not found on PATH. Install with ${how}, or see ${tool.docsUrl}`;
}

/**
 * Present, and usable? One `{ id, ok, detail }` line, the same shape every other pre-flight check
 * renders as (`renderChecks` in ui/render.ts).
 *
 * Running the binary rather than scanning PATH, because the two failures that matter are not the
 * same failure and only running tells them apart: `docker` on PATH with no daemon behind it, and
 * `flyctl` on PATH with nobody logged in, are both "installed" and neither is usable. Losing that
 * distinction would turn a one-line fix into a support question.
 */
export function checkTool(tool: CliTool, probe?: ToolProbe): PreflightCheck {
  const resolved = resolve(probe);
  const id = `${tool.bin}-ready`;

  let version: string;
  try {
    version = resolved.exec(tool.bin, tool.versionArgs);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    // ENOENT is "no such binary"; anything else means it ran and refused, which is a different
    // sentence — and on Docker specifically it is the daemon, not the install, that is missing.
    if (error.code === "ENOENT") {
      return { id, ok: false, detail: missingToolMessage(tool, probe) };
    }
    return {
      id,
      ok: false,
      detail: tool.readyHint ?? `${tool.label} is installed but did not run. See ${tool.docsUrl}`,
    };
  }

  if (tool.readyArgs) {
    try {
      resolved.exec(tool.bin, tool.readyArgs);
    } catch {
      return {
        id,
        ok: false,
        detail: tool.readyHint ?? `${tool.label} is installed but not ready. See ${tool.docsUrl}`,
      };
    }
  }

  // The version is worth carrying: "flyctl is ready" says nothing a failure would not have said
  // louder, and a version is the first thing anyone asks for when a provider CLI misbehaves.
  const detail = version ? `${tool.bin} is ready — ${firstLine(version)}` : `${tool.bin} is ready`;
  return { id, ok: true, detail };
}

/** Version output is one line often enough, and several lines often enough to be worth trimming. */
function firstLine(out: string): string {
  const [first] = out.split("\n");
  return (first ?? "").trim();
}

export type OfferInstallOptions = {
  probe?: ToolProbe | undefined;
  /** Skips the prompt. `--install-missing` — an unattended run that has said yes in advance. */
  assumeYes?: boolean | undefined;
  interactive?: boolean | undefined;
  /** Narration. stderr already, and already silenced under --json/--quiet. */
  say: (msg: string) => void;
};

export type InstallOutcome =
  | { ok: true; installed: true; command: string }
  /** Nothing was run, and `reason` is what the operator has to do about it. */
  | { ok: false; installed: false; reason: string };

/**
 * Offer to install a missing tool, and install it if the operator agrees.
 *
 * Four rules, and every one of them is the point rather than a detail:
 *
 *   - **Never without consent.** Running a package manager against somebody's machine is not a
 *     side effect of picking a menu item. `--install-missing` is consent given in advance; a
 *     prompt is consent given now; there is no third way.
 *   - **Never under `--no-input`.** An unattended run that mutates the machine by default is the
 *     wrong default, so this refuses and names the command instead.
 *   - **Never with `sudo`.** See NEEDS_ROOT.
 *   - **Never silently.** The install inherits stdio: it takes minutes, and a frozen terminal is
 *     indistinguishable from a hung one.
 */
export async function offerInstall(
  tool: CliTool,
  opts: OfferInstallOptions,
): Promise<InstallOutcome> {
  const command = installCommand(tool, opts.probe);
  if (!command) {
    return {
      ok: false,
      installed: false,
      reason:
        `No package manager warehousd recognises is on PATH, so it cannot install ${tool.label}. ` +
        `Install it with one of: ${allInstallCommands(tool).join(", ")}, or see ${tool.docsUrl}`,
    };
  }

  const printed = command.argv.join(" ");

  if (command.needsRoot) {
    return {
      ok: false,
      installed: false,
      reason: `${tool.label} installs system-wide here and warehousd does not run sudo. Run: sudo ${printed}`,
    };
  }

  if (!opts.assumeYes) {
    // `confirm` throws NonInteractiveError off a TTY, naming the flag — which is exactly the
    // refusal this case wants, so it is deliberately not caught here.
    const agreed = await confirm({
      message: `${tool.label} is not installed. Install it with \`${printed}\`?`,
      flag: "--install-missing",
      interactive: opts.interactive,
      initialValue: true,
    });
    if (!agreed) {
      return { ok: false, installed: false, reason: `Skipped. Install it later with: ${printed}` };
    }
  }

  opts.say(`Installing ${tool.label} — ${printed}`);
  traceCommand(command.manager, command.args);
  try {
    execFileSync(command.manager, command.args, {
      encoding: "utf8",
      // The one place stdio is inherited on purpose: an install is minutes long and the manager
      // narrates it better than we would, exactly as `docker pull` does in docker.ts.
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    traceFailure((error.message ?? "").trim());
    return {
      ok: false,
      installed: false,
      reason: `\`${printed}\` failed. Install ${tool.label} by hand and retry — see ${tool.docsUrl}`,
    };
  }

  return { ok: true, installed: true, command: printed };
}

// Declared here rather than imported from ./deploy/preflight for the same reason the broker
// declares `ProviderCheck` instead of importing this one: it keeps the dependency pointing one
// way. The two are structurally identical on purpose, so a check from here goes straight into a
// pre-flight array with no adapter.
export type PreflightCheck = { id: string; ok: boolean; detail: string };
