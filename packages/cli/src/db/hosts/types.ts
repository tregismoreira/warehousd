import type { DbProviderId } from "@warehousd/broker";
import type { CliTool, PreflightCheck } from "../../cli-tools";

/**
 * A provider whose CLI warehousd can drive to *create* a database, not merely connect to one.
 *
 * The counterpart to `DbProvider` in `packages/broker/src/db/providers`, and deliberately a
 * separate type in a separate package. That one is pure — it reads a URL and says how a role is
 * spelled — and it has to stay pure, because the broker is the trust boundary and runs no child
 * processes (AGENTS.md, Non-negotiable 1). This one shells out. The two are keyed by the same
 * `DbProviderId` so they cannot drift.
 *
 * Modelled on `DeployTarget` because it is the same problem one layer down: `provision` is
 * `ensureApp` plus `provisionDatabase`, and `destroy` is `destroy`.
 */
export type DbHost = {
  id: DbProviderId;
  label: string;
  cli: CliTool;
  /** Region codes this provider actually has, for a refusal that points somewhere concrete. */
  exampleRegions: string;
  /** Is the CLI present, authenticated, and is the config it needs complete? Never mutates. */
  preflight(input: DbHostPreflightInput): Promise<PreflightCheck[]>;
  /**
   * Create the database and hand back the owner URL.
   *
   * Called only when `state` holds no record of one — `ensureProvisioned` in deploy.ts is what
   * makes a redeploy reconnect rather than create a second project. Implementations may assume
   * they are being asked to create something new.
   */
  provision(ctx: DbHostContext): Promise<Provisioned>;
  /**
   * Rebuild the owner URL for a database created on an earlier run.
   *
   * Separate from `provision` because the two providers answer differently: Neon can be asked
   * (`neon connection-string`), while Supabase cannot — its URL is derived from a ref and a
   * password warehousd stored, because nothing reads that password back out.
   */
  reconnect(ctx: DbHostContext, saved: SavedDatabase): Promise<string>;
  /** Delete it. Called from `--destroy`, where there is no `state` to write. */
  destroy(ctx: DbHostContext, saved: SavedDatabase): Promise<void>;
  /**
   * A dev stack on this machine. Absent when the provider has none, which is Neon: it is a hosted
   * service with no local mode, and the init wizard therefore never offers it as a local option.
   */
  local?: DbHostLocal;
};

export type DbHostLocal = {
  /** Boot it, returning the URL warehousd should connect to. Idempotent. */
  start(ctx: LocalContext): Promise<string>;
  stop(ctx: LocalContext): Promise<void>;
  /** The URL if it is already running, null if it is not. Never starts anything. */
  status(ctx: LocalContext): Promise<string | null>;
};

/** What warehousd created, and everything needed to find it again. */
export type Provisioned = {
  /** The owner connection URL. Carries a credential — never write it to outputs. */
  url: string;
  /** The provider's handle: a Supabase project ref, a Neon project id. */
  ref: string;
  /** Only where warehousd generated it and holds the only copy — Supabase. */
  password?: string;
};

/** The `state.json` record of a previous `provision`. */
export type SavedDatabase = {
  provider: string;
  ref: string;
  password?: string;
  createdAt: string;
};

export type DbHostContext = {
  projectDir: string;
  /** `deploy.app_name` — what the created project is named after. */
  appName: string;
  /** `deploy.database.region`. Absent is a refusal the host raises in its own words. */
  region: string | undefined;
  /** `deploy.database.org`, for the one provider that needs it. */
  org: string | undefined;
  /** Narration, already routed to stderr and already silenced under --json/--quiet. */
  say: (msg: string) => void;
};

export type LocalContext = {
  projectDir: string;
  say: (msg: string) => void;
};

export type DbHostPreflightInput = {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  region: string | undefined;
  org: string | undefined;
};
