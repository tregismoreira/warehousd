import type { CliTool } from "../../cli-tools";
import type { ContainerRuntime } from "./types";

/**
 * Podman, which speaks Docker's argv.
 *
 * No `readyArgs`: rootless Podman has no daemon to be down. `podman --version` answering is the
 * whole of "usable", where for Docker it is only half.
 *
 * **Unverified.** Selecting this runs every `docker` subcommand warehousd issues against `podman`,
 * and those subcommands are compatible — but rootless networking and volume labelling under SELinux
 * are real differences that nothing in this repo exercises yet. It ships selectable and said-so
 * rather than claimed to work; see docs/deploy-compose.md.
 */
const cli: CliTool = {
  bin: "podman",
  label: "Podman",
  versionArgs: ["--version"],
  docsUrl: "https://podman.io/docs/installation",
  installers: [
    { manager: "brew", args: ["install", "podman"] },
    { manager: "apt-get", args: ["install", "-y", "podman"] },
    { manager: "dnf", args: ["install", "-y", "podman"] },
    { manager: "winget", args: ["install", "RedHat.Podman"] },
  ],
};

export const podman: ContainerRuntime = {
  id: "podman",
  label: "Podman",
  // Says "unverified" because it is — see the header. A hint that oversold it would be the one
  // place somebody reads before choosing.
  blurb: "rootless, no daemon — compatible but not yet verified here",
  cli,
  hasDaemon: false,
};
