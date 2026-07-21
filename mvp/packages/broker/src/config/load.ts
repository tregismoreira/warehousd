import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ConfigSchema, type WarehousdConfig } from "./schema";

function interpolate(raw: string): string {
  return raw.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`Unresolved \${env:${name}} in warehousd.yml`);
    return v;
  });
}

function deepMerge<T>(base: T, over: Partial<T>): T {
  if (Array.isArray(base) || Array.isArray(over)) return (over ?? base) as T;
  if (typeof base !== "object" || base === null) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as object) };
  for (const [k, v] of Object.entries(over as object)) {
    out[k] = k in (base as object) ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export function loadConfig(dir: string): WarehousdConfig {
  const basePath = join(dir, "warehousd.yml");
  if (!existsSync(basePath)) throw new Error(`No warehousd.yml in ${dir}`);
  let cfg = parse(interpolate(readFileSync(basePath, "utf8"))) as unknown;
  const localPath = join(dir, "warehousd.local.yml");
  if (existsSync(localPath)) {
    const local = parse(interpolate(readFileSync(localPath, "utf8"))) as object;
    cfg = deepMerge(cfg as object, local);
  }
  return ConfigSchema.parse(cfg);
}

// The two-tier deny (§5.3): fields marked posture:deny can never be granted.
export function grantableFields(cfg: WarehousdConfig, collection: string): string[] {
  const c = cfg.collections[collection];
  if (!c) return [];
  return Object.entries(c.fields).filter(([, f]) => f.posture === "allow").map(([n]) => n);
}
