import { resolve } from "node:path";
import { loadConfig, type WarehousdConfig } from "@warehousd/broker";

export type Project = {
  dir: string;                 // absolute project dir
  cfg: WarehousdConfig;
  name: string;                // sanitised cfg.project
  ns: { net: string; db: string; server: string; volume: string; label: string };
  ports: { server: number; db: number };
  managed: boolean;            // true unless cfg.database.url is set
};

// Container/volume/network names must be a safe docker identifier. cfg.project is free text.
function sanitise(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  if (!s) throw new Error(`project name "${name}" has no usable characters`);
  return s;
}

export function resolveProject(dir: string): Project {
  const abs = resolve(dir);
  const cfg = loadConfig(abs);
  const name = sanitise(cfg.project);
  const server = cfg.server.port;
  return {
    dir: abs, cfg, name,
    ns: {
      net: `wh_${name}_net`, db: `wh_${name}_db`,
      server: `wh_${name}_server`, volume: `wh_${name}_pgdata`,
      label: `warehousd.project=${name}`,
    },
    ports: { server, db: cfg.database?.port ?? server + 1 },
    managed: !cfg.database?.url,
  };
}
