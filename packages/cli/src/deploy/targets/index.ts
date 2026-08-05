import { DEPLOY_TARGET_IDS, type DeployTargetId } from "@warehousd/broker";
import type { DeployTarget } from "./types";
import { fly } from "./fly";
import { railway } from "./railway";
import { compose } from "./compose";

/**
 * Every place warehousd can deploy to.
 *
 * Another target is one file and one line here — nothing else in the codebase may branch on a
 * target id. `satisfies Record<DeployTargetId, DeployTarget>` is what keeps this in step with
 * `DEPLOY_TARGET_IDS` in the broker: an id added there with no module here does not compile, and a
 * module here with no id there does not either.
 */
export const targets = {
  fly,
  railway,
  compose,
} satisfies Record<DeployTargetId, DeployTarget>;

export function targetFor(id: DeployTargetId): DeployTarget {
  return targets[id];
}

export { DEPLOY_TARGET_IDS };
export type { DeployTarget, TargetContext, TargetPreflightInput } from "./types";
