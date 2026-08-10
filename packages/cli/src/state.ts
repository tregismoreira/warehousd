import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { WarehousdConfig } from "@warehousd/broker";

export type State = {
  dbPassword: string;
  dataRolePassword: string;
  betterAuthSecret: string;
  adminPassword: string;
  // The outputs-contract OAuth client's secret. Generated here, like every other secret, because
  // the process that has to print it is this one: the container stores only a hash of it, so it
  // cannot be read back out of the database on a later `start`.
  devClientSecret: string;
  // HMAC key for `mask: { transform: hash }`. Without it every read of a hash-masked field is an
  // internal_error, so it is provisioned with the rest rather than left to the operator.
  maskKey: string;
  /**
   * The hosted database warehousd created, when it created one.
   *
   * This is the only record that it exists. Fly and Railway get idempotence for free — the
   * target's own project *is* the identity, so `ensureApp` can ask "is it there?" — and a
   * provider host cannot: `supabase projects create` is not idempotent, and without this every
   * `warehousd deploy` would bill a new project.
   *
   * `password` is here because for Supabase it is the only copy in existence: warehousd generates
   * it, passes it to `projects create`, and nothing can read it back afterwards. state.json is
   * mode 0600 and `.warehousd/` is gitignored; this must never reach `outputs.deploy.json`, which
   * is a machine contract rather than a secret store.
   */
  database?: {
    provider: string;
    /** The provider's own handle: a Supabase project ref, a Neon project id. */
    ref: string;
    password?: string;
    /** Recorded so a later run can say what it is reconnecting to without asking the API. */
    createdAt: string;
  };
};

export type Outputs = {
  mcpUrl: string;
  apiUrl: string;
  adminUrl: string;
  databaseUrl: string;
  env: "dev" | "live";
  devClient: {
    clientId: string;
    clientSecret: string;
  };
};

// Outputs written to disk after a deployment, whichever target ran it. Unlike the local outputs
// contract, databaseUrl is null when the target manages Postgres — never write a production URL
// into a file at rest. devClient does not apply to production deploys.
export type DeployOutputs = {
  mcpUrl: string;
  apiUrl: string;
  adminUrl: string;
  databaseUrl: string | null;
  env: "dev";
  deployedAt: string;
  configSnapshot: WarehousdConfig;
  // The migration filenames present at deploy time. Optional because it genuinely may be absent:
  // readDeployOutputs is a bare JSON.parse of a file an earlier CLI wrote. Pre-flight reads it to
  // tell "the operator wrote a migration for this change" from "they have not yet".
  migrationVersions?: string[];
};

export function stateDir(dir: string): string {
  return join(dir, ".warehousd");
}

function statePath(dir: string): string {
  return join(stateDir(dir), "state.json");
}

function outputsPath(dir: string): string {
  return join(stateDir(dir), "outputs.json");
}

function deployOutputsPath(dir: string): string {
  return join(stateDir(dir), "outputs.deploy.json");
}

export function readState(dir: string): State | null {
  const path = statePath(dir);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  return JSON.parse(content);
}

export function ensureState(dir: string): State {
  mkdirSync(stateDir(dir), { recursive: true });

  // Read existing state if it exists (to support partial writes)
  let existing: Partial<State> = {};
  const path = statePath(dir);
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Ignore parse errors, treat as empty
      existing = {};
    }
  }

  // Fill in missing keys only
  const state: State = {
    dbPassword: existing.dbPassword ?? randomBytes(24).toString("hex"),
    dataRolePassword: existing.dataRolePassword ?? randomBytes(24).toString("hex"),
    betterAuthSecret: existing.betterAuthSecret ?? randomBytes(24).toString("hex"),
    adminPassword: existing.adminPassword ?? randomBytes(24).toString("hex"),
    devClientSecret: existing.devClientSecret ?? randomBytes(32).toString("hex"),
    maskKey: existing.maskKey ?? randomBytes(32).toString("hex"),
    // Carried through rather than regenerated: unlike the secrets above, this one names something
    // that exists outside this machine, and inventing a fresh value would orphan a real project.
    ...(existing.database ? { database: existing.database } : {}),
  };

  // Write state with restricted permissions
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });

  return state;
}

/**
 * Record — or forget — the hosted database warehousd created.
 *
 * A read-modify-write over the existing file rather than a fresh `ensureState`, so recording a
 * project never rotates a secret as a side effect. Passing `null` is what `--destroy` does once
 * the project is gone: leaving the ref behind would make the next deploy try to reconnect to
 * something that no longer exists.
 */
export function writeDatabaseState(dir: string, database: State["database"] | null): void {
  const state = ensureState(dir);
  if (database) {
    state.database = database;
  } else {
    delete state.database;
  }
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function writeOutputs(dir: string, outputs: Outputs): void {
  mkdirSync(stateDir(dir), { recursive: true });
  const path = outputsPath(dir);
  writeFileSync(path, JSON.stringify(outputs, null, 2), { mode: 0o600 });
}

export function readOutputs(dir: string): Outputs | null {
  const path = outputsPath(dir);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  return JSON.parse(content);
}

export function writeDeployOutputs(dir: string, outputs: DeployOutputs): void {
  mkdirSync(stateDir(dir), { recursive: true });
  const path = deployOutputsPath(dir);
  writeFileSync(path, JSON.stringify(outputs, null, 2), { mode: 0o600 });
}

export function readDeployOutputs(dir: string): DeployOutputs | null {
  const path = deployOutputsPath(dir);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  return JSON.parse(content);
}
