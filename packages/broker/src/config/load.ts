import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ConfigSchema, type WarehousdConfig } from "./schema";

// Split a line into (code, comment) at the first unquoted "#" preceded by
// whitespace or start-of-line, per YAML comment syntax — so `${env:...}`
// refs inside trailing comments aren't mistaken for real references.
function splitInlineComment(line: string): { code: string; comment: string } {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
  }
  return { code: line, comment: '' };
}

function interpolate(raw: string): string {
  const lines = raw.split('\n');
  const interpolated = lines.map(line => {
    // Skip lines that are YAML comments (trimmed line starts with #)
    if (line.trim().startsWith('#')) return line;

    const { code, comment } = splitInlineComment(line);
    const interpolatedCode = code.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, name) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`Unresolved \${env:${name}} in warehousd.yml`);
      return v;
    });
    return interpolatedCode + comment;
  });
  return interpolated.join('\n');
}

function deepMerge<T>(base: T, over: Partial<T>): T {
  if (Array.isArray(base) || Array.isArray(over)) return (over ?? base) as T;
  if (typeof base !== "object" || base === null) return (over ?? base) as T;
  // Use Object.create(null) to avoid assigning to __proto__ as a computed key
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(base as object)) out[k] = v;
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

// Collection names arrive from request bodies and MCP tool calls, and `cfg.collections[name]`
// is a property read, not a membership test: every object literal already answers to
// `constructor`, `toString`, `__proto__` and friends. Those names returned a truthy
// non-collection that sailed past each caller's `if (!c)` refusal and threw on `.fields`.
// The throw was the smaller half — refusals are what write the audit row, so a probe using
// one of those names left no trace in the trail. Own properties only.
export function findCollection(
  cfg: WarehousdConfig, name: string,
): WarehousdConfig["collections"][string] | null {
  return Object.hasOwn(cfg.collections, name) ? cfg.collections[name]! : null;
}

// The two-tier deny (§5.3): fields marked posture:deny can never be granted.
export function grantableFields(cfg: WarehousdConfig, collection: string): string[] {
  const c = findCollection(cfg, collection);
  if (!c) return [];
  return Object.entries(c.fields).filter(([, f]) => f.posture === "allow").map(([n]) => n);
}
