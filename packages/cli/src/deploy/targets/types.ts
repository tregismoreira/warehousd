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
  region: string;
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
  /** Human name, for checklist details and error messages. */
  label: string;
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
   * The base URL to poll `/api/health` against and to print.
   *
   * null means the operator starts the stack themselves, which skips the health poll — there is no
   * point timing out for three minutes against something nobody has run yet.
   */
  appUrl(ctx: TargetContext): Promise<string | null>;
  /** Recent logs, appended to a health-check failure. Absent when the target has none to offer. */
  logs?(ctx: TargetContext): Promise<string>;
};
