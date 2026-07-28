export type ApplyStatus = "not_applied" | "applied" | "drifted";

// Order-insensitive structural comparison. `applyConfig` stores the parsed collection config
// as JSONB, and Postgres does not preserve object key order, so a naive JSON.stringify
// comparison would report drift on every read.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]));
  }
  return v;
}

// Desired state is the YAML on disk; deployed state is what `warehousd apply` last wrote
// into app.collections.config. Three outcomes, no fourth.
export function applyStatus(yaml: unknown, applied: unknown | null): ApplyStatus {
  if (applied === null || applied === undefined) return "not_applied";
  return JSON.stringify(canonical(yaml)) === JSON.stringify(canonical(applied))
    ? "applied" : "drifted";
}
