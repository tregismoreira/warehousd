import { execFileSync } from "node:child_process";
import { traceCommand, traceFailure } from "./verbose";

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
};

export function dockerVersion(): string {
  return execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    stdio: CAPTURED,
  }).trim();
}

export function assertDocker(): void {
  try {
    dockerVersion();
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (error.code === "ENOENT") {
      throw new DockerError(
        "docker not found on PATH. Install Docker Desktop (https://docs.docker.com/get-docker/) and retry.",
      );
    }
    throw new DockerError(
      "Docker is installed but the daemon isn't reachable. Start Docker and retry.",
    );
  }
}

export function run(args: string[], opts?: { inheritStderr?: boolean }): string {
  traceCommand("docker", args);
  try {
    const output = execFileSync("docker", args, {
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

export function logs(name: string, tail?: number): string {
  const args = ["logs"];
  if (tail) {
    args.push("--tail", String(tail));
  }
  args.push(name);
  return run(args);
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
