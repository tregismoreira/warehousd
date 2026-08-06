import type { DeployConfig, DeployTargetId, WarehousdConfig } from "@warehousd/broker";
import type { State } from "../../state";
import type { PreflightCheck } from "../preflight";

/**
 * Everything a target needs to act, assembled once by `runDeploy` and handed to every method.
 *
 * A context rather than a long argument list because the methods are called at six different
 * points in the run and they do not agree on which parts they need — `setSecrets` wants the app
 * name, `deploy` wants the bundle directories, `destroy` wants neither.
 */
export type TargetContext = {
  projectDir: string;
  cfg: WarehousdConfig;
  deploy: DeployConfig;
  appName: string;
  /** Absent when the config names none. Targets with regions refuse that in preflight; Compose,
      which has none to name, never reads this. */
  region: string | undefined;
  /**
   * The generated credentials, for a target that has to send them.
   *
   * null on the `--destroy` path, which deliberately does not call `ensureState` — generating a
   * fresh set of secrets while tearing a deployment down would write state.json for an app that is
   * about to stop existing.
   */
  state: State | null;
  /** `.warehousd/deploy` — where a target writes whatever its own CLI reads. */
  deployDir: string;
  /** `.warehousd/deploy/context` — the project bundle, written by `writeBundle` before `deploy`. */
  contextDir: string;
  localBuild: boolean;
  /** Narration, already routed to stderr and already silenced under --json/--quiet. */
  say: (msg: string) => void;
};

/**
 * What a target's pre-flight gets. `cfg` is null when `warehousd.yml` did not load at all, which is
 * not a reason to skip the check: whether the target's CLI is installed is answerable either way,
 * and answering it is more useful than reporting nothing.
 */
export type TargetPreflightInput = {
  projectDir: string;
  cfg: WarehousdConfig | null;
  env: NodeJS.ProcessEnv;
};

/**
 * Where a deployment's container runs.
 *
 * Every behavioural difference between Fly, Railway and a Compose file is a method here. Nothing
 * outside `deploy/targets` may branch on a target id — a `switch (target)` in `runDeploy` is the
 * shape this interface exists to prevent, and it is what makes a fourth target one new file.
 */
export type DeployTarget = {
  id: DeployTargetId;
  /** Human name, for checklist details, error messages and the deploy summary's heading. */
  label: string;
  /**
   * Where to find the database when `managed: true` left no URL to print.
   *
   * The summary used to say ``managed by Fly Postgres — `fly postgres connect` `` for every managed
   * deploy on any target, which was the last Fly-specific string in shared rendering code. It is
   * not part of `DeployOutputs` because that is serialised to `.warehousd/outputs.deploy.json`, and
   * a sentence about a CLI does not belong in a machine contract.
   */
  databaseHint: string;
  /**
   * A region this target actually has, for the `deploy:` block `warehousd init` scaffolds.
   *
   * `region` is required by `DeploySchema` and its shape belongs to the target, so a scaffold that
   * guessed one would write a file that fails the target's own pre-flight. It lives here for the
   * same reason `databaseHint` does: nothing outside `deploy/targets` may branch on a target id,
   * so per-target text is a member rather than a lookup table somewhere else.
   */
  exampleRegion: string;
  /** Is the target's CLI present and authenticated, is the region one it has? Never mutates. */
  preflight(input: TargetPreflightInput): Promise<PreflightCheck[]>;
  /** Create the app/project on the target. Idempotent: a redeploy calls it too. */
  ensureApp(ctx: TargetContext): Promise<void>;
  /**
   * Provision the target's own Postgres, under `database.managed: true` only.
   *
   * Returns the app-role URL, or null when the target injects it into the app's environment itself
   * — which is Fly's case, and the reason `entrypoint.ts` accepts `DATABASE_URL` as well as
   * `APP_DATABASE_URL`. Absent when the target cannot provision one at all, which makes
   * `managed: true` a refusal rather than a crash.
   */
  provisionDatabase?(ctx: TargetContext): Promise<string | null>;
  /** Ship the KEY=VALUE lines. Secret material — keep it off argv wherever the CLI allows. */
  setSecrets(ctx: TargetContext, lines: string[]): Promise<void>;
  /** Push the image or bundle and wait for the release to land. */
  deploy(ctx: TargetContext): Promise<void>;
  destroy(ctx: TargetContext): Promise<void>;
  /**
   * What the operator is about to agree to, above the type-the-app-name prompt.
   *
   * Absent when the default is true: `--destroy` destroys the app and its database, and the
   * database may hold real data. It exists for the target where that sentence is a lie — Compose
   * destroys nothing, because the stack is running on a machine this command does not control, and
   * a prompt that overstates what it does trains people to type through prompts.
   */
  destroyWarning?(ctx: TargetContext): string;
  /**
   * The base URL to poll `/api/health` against and to print.
   *
   * null means the operator starts the stack themselves, which skips the health poll — there is no
   * point timing out for three minutes against something nobody has run yet.
   */
  appUrl(ctx: TargetContext): Promise<string | null>;
  /** Recent logs, appended to a health-check failure. Absent when the target has none to offer. */
  logs?(ctx: TargetContext): Promise<string>;
  /**
   * What the operator still has to do, and what is theirs to secure — printed under the summary.
   *
   * Absent when a successful deploy leaves nothing outstanding, which is every target that runs
   * the container itself. It exists for the one that does not: a rendered Compose stack is not a
   * running one, and the line saying so must survive `--quiet`, which silences `say`.
   */
  notes?(ctx: TargetContext): string[];
};
