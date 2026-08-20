import { readFileSync, existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { kindOf } from "./kinds";
import { describeZodError } from "../zod-error";
import {
  ConfigSchema,
  readPosture,
  writePosture,
  unmaskPosture,
  isGrantable,
  type WarehousdConfig,
} from "./schema";

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
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
  }
  return { code: line, comment: "" };
}

function interpolate(raw: string): string {
  const lines = raw.split("\n");
  const interpolated = lines.map((line) => {
    // Skip lines that are YAML comments (trimmed line starts with #)
    if (line.trim().startsWith("#")) return line;

    const { code, comment } = splitInlineComment(line);
    const interpolatedCode = code.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, name) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`Unresolved \${env:${name}} in warehousd.yml`);
      return v;
    });
    return interpolatedCode + comment;
  });
  return interpolated.join("\n");
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
  if (!existsSync(basePath)) {
    // `existsSync` answers false for "no such file" and for "not allowed to look" alike — it
    // swallows EACCES. Under Docker `dir` is a bind mount and the container user is not the host
    // user, so an unreadable project directory is a real case, and reporting it as a missing file
    // sends the reader looking for the wrong thing entirely.
    //
    // Only EACCES earns the different message. A directory that is simply not there also makes
    // accessSync throw, with ENOENT, and reporting that as a permission problem would trade one
    // misleading error for another.
    try {
      accessSync(dir, constants.R_OK | constants.X_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(`Cannot read ${dir}: permission denied`, { cause: err });
      }
    }
    throw new Error(`No warehousd.yml in ${dir}`);
  }
  let cfg = parse(interpolate(readFileSync(basePath, "utf8"))) as unknown;
  const localPath = join(dir, "warehousd.local.yml");
  if (existsSync(localPath)) {
    const local = parse(interpolate(readFileSync(localPath, "utf8"))) as object;
    cfg = deepMerge(cfg as object, local);
  }
  const parsed = ConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    // ZodError's own message is the serialised issue array, so anything printing an error on one
    // line showed a bare "[". Config errors are read by a person editing YAML; name the key.
    throw new Error(`Invalid warehousd.yml: ${describeZodError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

// Whether decisions are recorded at all. The `??` is not belt-and-braces: most of the test suite
// hand-builds a config object and casts it rather than going through zod, so the key is genuinely
// absent for those callers and there is no default to read — the same reason `isMultiValueField`
// optional-chains `taxonomies` (verbs/deps.ts). Defaulting to true here means the only way to lose
// the trail is to ask for it in writing.
export function auditEnabled(cfg: WarehousdConfig): boolean {
  return cfg.audit?.enabled ?? true;
}

// Whether the platform provisioning API (`/v1/platform/*`, `warehousd platform-key`) is mounted
// at all. Off by default — the `??` mirrors auditEnabled's, for the same reason: most of the test
// suite hand-builds a config and casts it rather than going through zod, so `workspaces` is
// genuinely absent for those callers.
//
// This flag gates exactly four things — the platform routes (404 when off), `platform-key create`
// (refuses, naming the fix), the admin/members page and route, and the console workspace
// switcher's render condition. It gates NOTHING about isolation: RLS, view predicates,
// withWorkspace, membership-based role resolution and resolveWorkspace all run unconditionally
// whether this is true or false. Turning it on adds no enforcement and removes none — it exposes
// the means to create a second workspace. See docs/configuration.md.
export function workspacesEnabled(cfg: WarehousdConfig): boolean {
  return cfg.workspaces?.enabled ?? false;
}

// Collection names arrive from request bodies and MCP tool calls, and `cfg.collections[name]`
// is a property read, not a membership test: every object literal already answers to
// `constructor`, `toString`, `__proto__` and friends. Those names returned a truthy
// non-collection that sailed past each caller's `if (!c)` refusal and threw on `.fields`.
// The throw was the smaller half — refusals are what write the audit row, so a probe using
// one of those names left no trace in the trail. Own properties only.
export function findCollection(
  cfg: WarehousdConfig,
  name: string,
): WarehousdConfig["collections"][string] | null {
  return Object.hasOwn(cfg.collections, name) ? cfg.collections[name]! : null;
}

// The two-tier deny (§5.3): fields that can be granted for reading.
//
// `mask` counts. It is a disclosure LEVEL, not a refusal — a manager approving a masked field is
// approving the transformed value — so excluding it here would make a masked field ungrantable
// and therefore unreadable, which is what `deny` is for.
export function grantableFields(cfg: WarehousdConfig, collection: string): string[] {
  const c = findCollection(cfg, collection);
  if (!c) return [];
  return Object.entries(c.fields)
    .filter(([, f]) => isGrantable(f))
    .map(([n]) => n);
}

// Fields whose RAW value a grant may additionally carry. Always a subset of grantableFields, and
// only ever a field the config marked `unmask: allow` — a manager cannot widen a mask that the
// YAML did not offer to widen.
export function unmaskableFields(cfg: WarehousdConfig, collection: string): string[] {
  const c = findCollection(cfg, collection);
  if (!c) return [];
  return Object.entries(c.fields)
    .filter(([, f]) => unmaskPosture(f) === "allow")
    .map(([n]) => n);
}

// The fields a grant would see transformed: masked, and not carried in the grant's unmask list.
// One definition, used by every read verb and by describeCollection, so "is this masked for this
// caller?" cannot be answered two ways.
export function maskedFieldsFor(
  cfg: WarehousdConfig,
  collection: string,
  unmasked: readonly string[],
): string[] {
  const c = findCollection(cfg, collection);
  if (!c) return [];
  return Object.entries(c.fields)
    .filter(([n, f]) => readPosture(f) === "mask" && !unmasked.includes(n))
    .map(([n]) => n);
}

// Fields that can be written to (write:allow).
export function writableFields(cfg: WarehousdConfig, collection: string): string[] {
  const c = findCollection(cfg, collection);
  if (!c) return [];
  return Object.entries(c.fields)
    .filter(([, f]) => writePosture(f) === "allow")
    .map(([n]) => n);
}

// Verbs this collection's structural type supports (if writable: true).
export function supportedVerbs(
  cfg: WarehousdConfig,
  collection: string,
): ("create" | "update" | "delete")[] {
  const c = findCollection(cfg, collection);
  if (!c) return [];
  // Structural: it follows from the KIND, so a fourth kind declares its own answer rather than
  // this function growing a third branch. See config/kinds/.
  return kindOf(c).supportedVerbs(c);
}

// Every `${env:NAME}` referenced by the config, without resolving any of them.
//
// `interpolate` throws on the first unresolved reference, which is right for loading but useless
// for a pre-flight check: an operator fixing a deploy wants the whole list at once, not one name
// per run. This is the read-only counterpart, and it deliberately does not throw — a caller that
// wants resolution still goes through loadConfig.
//
// Comment handling has to match `interpolate` exactly. `docs/configuration.md` ships a
// commented-out `# url: ${env:PROD_DATABASE_URL}`, and reporting that as a real reference would
// refuse a deploy over a line that does nothing.
export function envRefs(dir: string): string[] {
  const names = new Set<string>();

  const scan = (path: string): void => {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const { code } = splitInlineComment(line);
      // A fresh regex per line: a shared /g literal carries lastIndex between calls.
      for (const m of code.matchAll(/\$\{env:([A-Z0-9_]+)\}/g)) {
        const name = m[1];
        if (name) names.add(name);
      }
    }
  };

  const basePath = join(dir, "warehousd.yml");
  if (!existsSync(basePath)) return [];
  scan(basePath);
  scan(join(dir, "warehousd.local.yml"));

  return [...names].sort();
}
