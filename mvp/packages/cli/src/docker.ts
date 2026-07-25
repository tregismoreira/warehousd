import { execFileSync } from "node:child_process";

export class DockerError extends Error {}

export type ContainerSpec = {
  name: string;
  image: string;
  network: string;
  label: string;
  env?: Record<string, string>;
  ports?: Record<string | number, string | number>;
  volumes?: Record<string, string>;
};

export function assertDocker(): void {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
    });
  } catch (err: unknown) {
    const error = err as any;
    if (error.code === "ENOENT") {
      throw new DockerError(
        "docker not found on PATH. Install Docker Desktop (https://docs.docker.com/get-docker/) and retry."
      );
    }
    throw new DockerError(
      "Docker is installed but the daemon isn't reachable. Start Docker and retry."
    );
  }
}

export function run(args: string[]): string {
  try {
    const output = execFileSync("docker", args, { encoding: "utf8" });
    return output.trim();
  } catch (err: unknown) {
    const error = err as any;
    throw new DockerError(error.stderr || error.message);
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
  run(["pull", ref]);
}

export function containerState(
  name: string
): "running" | "exited" | "absent" {
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
  if (
    tryRun(["network", "inspect", name]).ok
  ) {
    return;
  }
  run(["network", "create", "--label", label, name]);
}

export function ensureVolume(name: string, label: string): void {
  if (
    tryRun(["volume", "inspect", name]).ok
  ) {
    return;
  }
  run(["volume", "create", "--label", label, name]);
}

export function removeContainer(name: string): void {
  run(["rm", "-f", name]);
}

export function removeVolume(name: string): void {
  run(["volume", "rm", "-f", name]);
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
