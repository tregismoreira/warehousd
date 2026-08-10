import { resolve } from "node:path";
import { loadConfig, type WarehousdConfig } from "@warehousd/broker";
import { runtimeFor } from "./containers/runtimes";
import { setContainerRuntime } from "./docker";

type ProjectBase = {
  dir: string; // absolute project dir
  cfg: WarehousdConfig;
  name: string; // sanitised cfg.project
  ns: {
    net: string;
    db: string;
    server: string;
    volume: string;
    label: string;
  };
  ports: { server: number; db: number };
};

// A union rather than `managed: boolean`, so that "unmanaged means there is a database URL" is a
// fact the compiler carries instead of one a caller has to remember. start.ts read
// `p.cfg.database.url!` in its `else` branch — correct, but only because of a correlation computed
// in this file, which is exactly the kind of thing a non-null assertion stops anyone noticing.
export type Project =
  | (ProjectBase & { managed: true }) // the CLI runs Postgres in Docker
  | (ProjectBase & { managed: false; databaseUrl: string }); // cfg.database.url points elsewhere

// Container/volume/network names must be a safe docker identifier. cfg.project is free text.
function sanitise(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) throw new Error(`project name "${name}" has no usable characters`);
  return s;
}

export function resolveProject(dir: string): Project {
  const abs = resolve(dir);
  const cfg = loadConfig(abs);
  const name = sanitise(cfg.project);
  const server = cfg.server.port;
  const base: ProjectBase = {
    dir: abs,
    cfg,
    name,
    ns: {
      net: `wh_${name}_net`,
      db: `wh_${name}_db`,
      server: `wh_${name}_server`,
      volume: `wh_${name}_pgdata`,
      label: `warehousd.project=${name}`,
    },
    ports: { server, db: cfg.database?.port ?? server + 1 },
  };
  const databaseUrl = cfg.database?.url;
  return databaseUrl ? { ...base, managed: false, databaseUrl } : { ...base, managed: true };
}

/**
 * Resolve, and point the container wrapper at the engine this project asked for.
 *
 * Every command that touches a container goes through here rather than `resolveProject`, because
 * `server.runtime` has to be applied *before* the first `docker.run` and there is no other moment
 * that is true for all of them. The side effect is in the name for the same reason: `resolveProject`
 * stays pure so a test can build a Project without moving process-wide state under its neighbours.
 */
export function useProject(dir: string): Project {
  const project = resolveProject(dir);
  setContainerRuntime(runtimeFor(project.cfg.server.runtime));
  return project;
}
