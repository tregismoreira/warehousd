import type { WarehousdConfig } from "../config/schema";

const PG_TYPE: Record<string, string> = {
  uuid: "uuid", text: "text", numeric: "numeric", int: "integer",
  timestamptz: "timestamptz", date: "date", boolean: "boolean", json: "jsonb",
};

export function tableDDL(env: "dev" | "live", collection: string, cfg: WarehousdConfig): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  const cols: string[] = [];
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.view_join) continue; // join columns are not stored on the base table
    const pk = f.pk ? " primary key" : "";
    // type is guaranteed by CollectionSchema refinement for structured collections
    cols.push(`"${name}" ${PG_TYPE[f.type!]}${pk}`);
  }
  return `create table if not exists ${schema}.${collection} (${cols.join(", ")});`;
}

// One flat view per collection/env. Joins resolve view_join columns.
export function viewDDL(env: "dev" | "live", collection: string, cfg: WarehousdConfig): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  const selects: string[] = [];
  const joins: string[] = [];
  const seenJoin = new Set<string>();
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.view_join) {
      const [jt, jc] = f.view_join.split("."); // "departments.name"
      if (!jt || !jc) throw new Error(`Malformed view_join on field ${name}: ${f.view_join}`);
      const alias = `j_${jt}`;
      if (!seenJoin.has(jt)) {
        joins.push(`left join ${schema}.${jt} ${alias} on ${alias}.id = base.${jt.replace(/s$/, "")}_id`);
        seenJoin.add(jt);
      }
      selects.push(`${alias}."${jc}" as "${name}"`);
    } else {
      selects.push(`base."${name}"`);
    }
  }
  return `create or replace view ${schema}.v_${collection} as
    select ${selects.join(", ")} from ${schema}.${collection} base ${joins.join(" ")};`;
}

export function grantViewDDL(env: "dev" | "live", collection: string): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const role = env === "dev" ? "warehousd_dev" : "warehousd_live";
  return `grant select on ${schema}.v_${collection} to ${role};`;
}
