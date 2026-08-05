/**
 * Where a deployment's container runs.
 *
 * This is only the id list. The implementations live in `packages/cli/src/deploy/targets`, because
 * a target shells out to `flyctl` and the broker is the trust boundary — it imports nothing from
 * the CLI (AGENTS.md, Non-negotiable 1). The list has to live here anyway, because `DeploySchema`
 * validates against it.
 *
 * The two halves are held together at compile time: the CLI registry is
 * `satisfies Record<DeployTargetId, DeployTarget>`, so adding an id here without a module there is
 * a type error rather than a runtime one. The `db/providers` registry, whose implementations are
 * all broker-side, gets to derive its union with `keyof typeof` instead; this is the same idea
 * split across a package boundary.
 */
export const DEPLOY_TARGET_IDS = ["fly"] as const;

export type DeployTargetId = (typeof DEPLOY_TARGET_IDS)[number];

/**
 * The target assumed when there is no config to read one from.
 *
 * Pre-flight runs before `warehousd.yml` is known to be loadable and before a `deploy:` block is
 * known to exist, and it still has to report on *some* target's CLI — "flyctl is not installed" is
 * a more useful first answer than silence.
 */
export const DEFAULT_DEPLOY_TARGET_ID: DeployTargetId = "fly";
