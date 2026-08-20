import type { FieldConfig } from "../config/schema";

// The one place a JavaScript value becomes something node-postgres may bind to a declared column.
//
// It exists for `json`. `type: json` is `jsonb` (apply/ddl.ts), and the driver's asymmetry around
// that column is the whole bug: it PARSES jsonb on the way out and does not reverse that on the
// way in. `prepareValue` tests `Array.isArray(val)` before anything else, so a value that left
// Postgres as the array `["a","b"]` goes back as the Postgres *array literal* `{a,b}` and the
// column refuses it. An object survived only by accident, because prepareValue happens to fall
// through to JSON.stringify for it. The rendering is done here, deliberately, for every shape.
//
// This can stringify unconditionally rather than inspecting the value because of the contract
// stated on insertRevision: a json value arriving there is a JS value, never pre-serialised text.
// No inspection could do the job — a jsonb column may hold the JSON string `"draft"`, which pg
// returns as the JS string `draft`, and nothing distinguishes that from text already serialised.
// Provenance decides, and provenance is a contract, not a shape.
//
// NULL first. `typeof null === "object"`, so a null test placed second would serialise every empty
// json field into the four-character document `null` — a jsonb null, which `is null` does not
// match and which reads back as a value where there was none.
export function encodeForColumn(type: FieldConfig["type"], v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (type !== "json") return v;
  return JSON.stringify(v);
}
