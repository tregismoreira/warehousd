import type { CliTool } from "../../cli-tools";
import type { ContainerRuntime } from "./types";

/**
 * Docker, described for cli-tools.ts.
 *
 * The two args lists are doing different jobs. `--version` is the client alone and answers with no
 * daemon behind it; `version --format {{.Server.Version}}` asks the *server*, so it is what tells
 * "not installed" apart from "installed, daemon down" — the distinction assertRuntime has always
 * drawn and the one people actually hit.
 *
 * No apt/dnf installer on purpose. Docker on Linux means adding Docker's own repository first, and
 * a one-liner that is wrong in a way the operator cannot see is worse than the docs link.
 */
const cli: CliTool = {
  bin: "docker",
  label: "Docker",
  versionArgs: ["--version"],
  readyArgs: ["version", "--format", "{{.Server.Version}}"],
  readyHint: "Docker is installed but the daemon isn't reachable. Start Docker and retry.",
  docsUrl: "https://docs.docker.com/get-docker/",
  installers: [
    { manager: "brew", args: ["install", "--cask", "docker"] },
    { manager: "winget", args: ["install", "Docker.DockerDesktop"] },
  ],
};

/**
 * Docker, and the default.
 *
 * Orbstack and Colima are deliberately not separate entries. Both provide a `docker` CLI and a
 * socket behind it, so they are already this runtime; a registry entry would be a second name for
 * the same thing and a second place to keep in step.
 */
export const docker: ContainerRuntime = {
  id: "docker",
  label: "Docker",
  blurb: "what most people have, and what this is tested against",
  cli,
  hasDaemon: true,
};
