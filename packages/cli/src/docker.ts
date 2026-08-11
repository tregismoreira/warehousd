import { execFileSync, spawnSync } from "node:child_process";
import { checkTool, type PreflightCheck, type ToolProbe } from "./cli-tools";
import { docker } from "./containers/runtimes/docker";
import type { ContainerRuntime } from "./containers/runtimes/types";
import { traceCommand, traceFailure } from "./verbose";

// The wrapper around whichever container engine is selected. Still named docker.ts, and every
// subcommand below is still Docker's, because Podman takes the same ones — see
// containers/runtimes. `DockerError` keeps its name for the same reason: it is the error every
// caller already catches, and the engine it came from is in the message.
export class DockerError extends Error {}

// Why every call below passes `stdio` explicitly.
//
// `execFileSync`'s default is documented as `'pipe'`, but with a carve-out: the child's stderr is
// *also* written straight to the parent's stderr unless `stdio` is given. So each of the "does
// this exist yet?" probes — `network inspect`, `volume inspect`, `inspect -f` — announced its own
// negative answer to the user, in Docker's voice, on the ordinary first-run path:
//
//     Error response from daemon: network wh_harbor_net not found
//     Error response from daemon: get wh_harbor_pgdata: no such volume
//     error: no such object: wh_harbor_db
//
// All three mean "absent, so create it" and all three are success. Capturing stderr instead of
// echoing it also gives `err.stderr` something to hold, so a DockerError finally carries the real
// message rather than "Command failed: docker ...".
// stdin is "pipe", not "ignore": `execFileSync` silently discards its `input` option when stdio[0]
// is "ignore", so "ignore" is a trap for whoever next needs to pipe something in. See the same
// note in fly.ts, where `input` carries the deploy secrets.
const CAPTURED: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

// `docker pull` is the exception: its layer progress is genuine feedback on a minutes-long
// download, and Docker renders it better than we would. It is the one command allowed to speak.
const INHERIT_STDERR: ["pipe", "pipe", "inherit"] = ["pipe", "pipe", "inherit"];

// `--verbose` was accepted and silently ignored before this existed. The switch lives in
// verbose.ts because fly.ts needs the same one — see the note there.

export type ContainerSpec = {
  name: string;
  image: string;
  network: string;
  label: string;
  env?: Record<string, string>;
  ports?: Record<string | number, string | number>;
  volumes?: Record<string, string>;
  /** `--add-host` entries, for reaching a database running on the host rather than the network. */
  extraHosts?: Record<string, string>;
};

/**
 * Which engine every `run` below actually invokes.
 *
 * A module-level switch set once at command start, the same shape and for the same reason as
 * `setVerbose` in verbose.ts: fourteen exported functions here reach `run`, and threading a
 * binary name through all of them would put a parameter on every call site to express something
 * that is constant for the life of the process. `program.ts` resolves it from `server.runtime`
 * before anything is started, exactly where it already calls `setVerbose`.
 *
 * Podman is argv-compatible, so this is genuinely only the name — see containers/runtimes.
 */
let activeRuntime: ContainerRuntime = docker;

export function setContainerRuntime(runtime: ContainerRuntime): void {
  activeRuntime = runtime;
}

export function containerRuntime(): ContainerRuntime {
  return activeRuntime;
}

/** The engine's server version, for the line `warehousd start` prints first. */
export function runtimeVersion(): string {
  const bin = activeRuntime.cli.bin;
  // Podman answers `version --format {{.Server.Version}}` too, reporting its own version where
  // Docker reports the daemon's — which is the right answer in both cases.
  return execFileSync(bin, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    stdio: CAPTURED,
  }).trim();
}

/** Installed, and usable? The pre-flight form for whichever engine is selected — never throws. */
export function checkRuntime(probe?: ToolProbe): PreflightCheck {
  return checkTool(activeRuntime.cli, probe);
}

/** The throwing form, for the code paths that cannot carry on without a working engine. */
export function assertRuntime(probe?: ToolProbe): void {
  const check = checkRuntime(probe);
  if (!check.ok) throw new DockerError(check.detail);
}

export function run(args: string[], opts?: { inheritStderr?: boolean }): string {
  const bin = activeRuntime.cli.bin;
  traceCommand(bin, args);
  try {
    const output = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: opts?.inheritStderr ? INHERIT_STDERR : CAPTURED,
    });
    return output.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    const detail = (error.stderr || error.message || "").trim();
    traceFailure(detail);
    throw new DockerError(detail);
  }
}

export function tryRun(args: string[]): { ok: boolean; out: string } {
  try {
    const out = run(args);
    return { ok: true, out };
  } catch {
    return { ok: false, out: "" };
  }
}

export function imageExists(ref: string): boolean {
  const result = tryRun(["image", "inspect", ref]);
  return result.ok;
}

export function ensureImage(ref: string, opts?: { offline?: boolean }): void {
  if (imageExists(ref)) {
    return;
  }
  if (opts?.offline) {
    throw new DockerError(`Image ${ref} not found and offline mode is enabled`);
  }
  run(["pull", ref], { inheritStderr: true });
}

export function containerState(name: string): "running" | "exited" | "absent" {
  const result = tryRun(["inspect", "-f", "{{.State.Status}}", name]);
  if (!result.ok) {
    return "absent";
  }
  const status = result.out.toLowerCase();
  if (status === "running") return "running";
  if (status === "exited") return "exited";
  return "absent";
}

export function ensureNetwork(name: string, label: string): void {
  if (tryRun(["network", "inspect", name]).ok) {
    return;
  }
  run(["network", "create", "--label", label, name]);
}

export function ensureVolume(name: string, label: string): void {
  if (tryRun(["volume", "inspect", name]).ok) {
    return;
  }
  run(["volume", "create", "--label", label, name]);
}

// "Ensure absent", not "remove". A container that was never there is the desired end state, not a
// failure — and on Docker < 25 `rm -f` exited non-zero for it, which made a first `start` throw.
export function removeContainer(name: string): void {
  tryRun(["rm", "-f", name]);
}

export function removeVolume(name: string): void {
  run(["volume", "rm", "-f", name]);
}

export function removeNetwork(name: string): void {
  run(["network", "rm", name]);
}

export function buildRunArgs(spec: ContainerSpec): string[] {
  const args: string[] = [
    "run",
    "-d",
    "--label",
    spec.label,
    "--restart",
    "unless-stopped",
    "--network",
    spec.network,
    "--name",
    spec.name,
  ];

  // Add environment variables in sorted order
  if (spec.env) {
    const keys = Object.keys(spec.env).sort();
    for (const key of keys) {
      args.push("-e");
      args.push(`${key}=${spec.env[key]}`);
    }
  }

  // Add port mappings
  if (spec.ports) {
    for (const [host, container] of Object.entries(spec.ports)) {
      args.push("-p");
      args.push(`${host}:${container}`);
    }
  }

  // Add volume mounts
  if (spec.volumes) {
    for (const [container, host] of Object.entries(spec.volumes)) {
      args.push("-v");
      args.push(`${host}:${container}`);
    }
  }

  // Reach a service listening on the *host* rather than on this network. Docker Desktop resolves
  // `host.docker.internal` on its own; Linux does not, and needs it mapped explicitly. Passing it
  // on both is harmless and is one fewer platform branch.
  if (spec.extraHosts) {
    for (const [name, target] of Object.entries(spec.extraHosts)) {
      args.push("--add-host");
      args.push(`${name}:${target}`);
    }
  }

  // Image must be last
  args.push(spec.image);

  return args;
}

export function runContainer(spec: ContainerSpec): void {
  ensureImage(spec.image);
  ensureNetwork(spec.network, spec.label);

  // Create any volumes referenced in the spec
  if (spec.volumes) {
    for (const host of Object.values(spec.volumes)) {
      // Only create if it looks like a volume name (no slashes)
      if (!host.includes("/")) {
        ensureVolume(host, spec.label);
      }
    }
  }

  const args = buildRunArgs(spec);
  run(args);
}

/**
 * A container's logs — **both** of its streams.
 *
 * `docker logs` reproduces the split it recorded: the container's stdout on its own stdout, the
 * container's stderr on its own stderr. `run` returns execFileSync's stdout alone, so routing this
 * through it dropped every line the container wrote to stderr — which is where a Node process
 * writes an unhandled error, and therefore where every boot failure lands. The one caller is the
 * health-check timeout in `start`, so the "Container logs:" block printed empty in exactly the
 * situation it exists to explain, while `docker logs` showed the FATAL the whole time.
 *
 * spawnSync rather than execFileSync because it hands back both streams. A non-zero exit is not
 * checked: `docker logs` exits non-zero for a container that never started, and its stderr is then
 * the most useful thing we have to show. Interleaving is lost — the two streams are concatenated,
 * stdout first — which is the price of reading them separately and is worth paying to have them
 * at all.
 */
export function logs(name: string, tail?: number): string {
  const args = ["logs"];
  if (tail) {
    args.push("--tail", String(tail));
  }
  args.push(name);
  const bin = activeRuntime.cli.bin;
  traceCommand(bin, args);
  const result = spawnSync(bin, args, { encoding: "utf8" });
  // The engine is missing, or could not be executed at all. The caller is already reporting a
  // different failure and must not be displaced by this one.
  if (result.error) return `(container logs could not be read: ${result.error.message})`;
  return [result.stdout ?? "", result.stderr ?? ""]
    .map((s) => s.trim())
    .join("\n")
    .trim();
}

export type ContainerRow = { name: string; state: string };

/** Every container this project owns, running or not, for `status` and `doctor`. */
export function psByLabel(label: string): ContainerRow[] {
  const result = tryRun([
    "ps",
    "-a",
    "--filter",
    `label=${label}`,
    "--format",
    "{{.Names}}\t{{.Status}}",
  ]);
  if (!result.ok || !result.out) return [];
  return result.out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", state = ""] = line.split("\t");
      return { name, state };
    });
}

/** Which of this project's containers, if any, already holds a given host port. */
export function containerOnPort(port: number): string | null {
  const result = tryRun(["ps", "--format", "{{.Names}}\t{{.Ports}}"]);
  if (!result.ok || !result.out) return null;
  for (const line of result.out.split("\n")) {
    const [name = "", ports = ""] = line.split("\t");
    if (ports.includes(`:${port}->`)) return name;
  }
  return null;
}
