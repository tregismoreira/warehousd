import { CONTAINER_RUNTIME_IDS, type ContainerRuntimeId } from "@warehousd/broker";
import type { ContainerRuntime } from "./types";
import { docker } from "./docker";
import { podman } from "./podman";

/**
 * Every container engine warehousd can drive.
 *
 * Another runtime is one file and one line here — nothing else in the codebase may branch on a
 * runtime id, exactly as for `deploy/targets/index.ts`. `satisfies Record<ContainerRuntimeId, …>`
 * is what keeps this in step with `CONTAINER_RUNTIME_IDS` in the broker: an id added there with no
 * module here does not compile, and a module here with no id there does not either.
 */
export const runtimes = {
  docker,
  podman,
} satisfies Record<ContainerRuntimeId, ContainerRuntime>;

export function runtimeFor(id: ContainerRuntimeId): ContainerRuntime {
  return runtimes[id];
}

export { CONTAINER_RUNTIME_IDS };
export type { ContainerRuntime } from "./types";
