/**
 * Which container engine `warehousd start` drives on this machine.
 *
 * The id list only, for the same reason `targets.ts` holds only ids: a runtime is something the
 * CLI shells out to, and the broker is the trust boundary (AGENTS.md, Non-negotiable 1). The list
 * lives here because `ConfigSchema` validates against it, and the CLI registry is
 * `satisfies Record<ContainerRuntimeId, ContainerRuntime>` — so an id added here with no module
 * there does not compile.
 *
 * Docker-compatible argv is the reason this is a short list rather than a plugin system: Podman
 * takes the same subcommands, so what differs between the two is the binary name, the install
 * route, and whether a daemon has to be running at all.
 */
export const CONTAINER_RUNTIME_IDS = ["docker", "podman"] as const;

export type ContainerRuntimeId = (typeof CONTAINER_RUNTIME_IDS)[number];

/**
 * What a project gets when it says nothing.
 *
 * Docker rather than "whichever is installed": a config that resolves differently on two machines
 * is a config that cannot be reviewed in git, which is the property the whole product rests on.
 * Choosing Podman is a line in `warehousd.yml`, not an accident of what was on PATH.
 */
export const DEFAULT_CONTAINER_RUNTIME_ID: ContainerRuntimeId = "docker";
