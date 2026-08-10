import type { ContainerRuntimeId } from "@warehousd/broker";
import type { CliTool } from "../../cli-tools";

/**
 * A container engine warehousd can drive.
 *
 * Much thinner than `DeployTarget` on purpose. Podman is argv-compatible with Docker, so there is
 * nothing here that a method would be better than a field for: what differs is the binary's name,
 * how it is installed, and whether a daemon has to be up before anything works. The moment a
 * runtime needs different *subcommands* this becomes an interface with methods — until then, a
 * record of facts is the honest shape.
 */
export type ContainerRuntime = {
  id: ContainerRuntimeId;
  /** Human name, for the version line and for a refusal that reads as a sentence. */
  label: string;
  /** Presence, readiness and install routes — see cli-tools.ts. */
  cli: CliTool;
  /**
   * Whether this engine has a daemon that can be down while the binary is fine.
   *
   * Docker does. Rootless Podman does not — it execs the container itself — which is why its
   * `CliTool` has no `readyArgs` and why "installed" and "usable" are the same state there.
   */
  hasDaemon: boolean;
};
