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

// Outputs written to disk after a Fly deployment. Unlike the local outputs contract, databaseUrl
// is null when Fly manages Postgres — never write a production URL into a file at rest. devClient
// does not apply to production deploys.
export type DeployOutputs = {
  mcpUrl: string;
  apiUrl: string;
  adminUrl: string;
  databaseUrl: string | null;
  env: "dev";
  deployedAt: string;
  configSnapshot: WarehousdConfig;
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
  };

  // Write state with restricted permissions
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });

  return state;
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
