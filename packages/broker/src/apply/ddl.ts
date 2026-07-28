import type { WarehousdConfig } from "../config/schema";

const PG_TYPE: Record<string, string> = {
  uuid: "uuid", text: "text", numeric: "numeric", int: "integer",
  timestamptz: "timestamptz", date: "date", boolean: "boolean", json: "jsonb",
};

export function tableDDL(env: "dev" | "live", collection: string, cfg: WarehousdConfig): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);

  if (c.type === "file") {
    // Each bound vocabulary gets a column (text or text[] depending on cardinality)
    const termCols: string[] = [];
    const termAlters: string[] = [];
    for (const taxSlug of c.taxonomies ?? []) {
      const vocab = cfg.taxonomies[taxSlug];
      const colType = vocab?.multiple ? "text[]" : "text";
      termCols.push(`\n        "${taxSlug}" ${colType}`);
      termAlters.push(`\n      alter table ${schema}."${collection}__files" add column if not exists "${taxSlug}" ${colType};`);
      // A multi-value term column is only ever queried with `&&`/`= any`, which needs GIN.
      if (vocab?.multiple)
        termAlters.push(`\n      create index if not exists "${collection}__files_${taxSlug}_idx"`
          + ` on ${schema}."${collection}__files" using gin ("${taxSlug}");`);
    }
    const termCol = termCols.length > 0 ? termCols.join(",") + "," : "";
    const termAlter = termAlters.length > 0 ? termAlters.join("") : "";
    return `
      create table if not exists ${schema}."${collection}__files" (
        id uuid primary key,
        title text,
        path text not null unique,${termCol}
        owner text,
        checksum text not null,
        updated_at timestamptz not null);${termAlter}
      create table if not exists ${schema}."${collection}__documents" (
        id uuid primary key,
        file_id uuid not null references ${schema}."${collection}__files"(id) on delete cascade,
        document_seq int not null,
        content text not null,
        tsv tsvector generated always as (to_tsvector('english', content)) stored,
        embedding vector(1536),
        unique (file_id, document_seq));
      create index if not exists "${collection}__documents_tsv_idx"
        on ${schema}."${collection}__documents" using gin (tsv);`;
  }

  const cols: string[] = [];
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.view_join) continue; // join columns are not stored on the base table
    const pk = f.pk ? " primary key" : "";
    // type is guaranteed by CollectionSchema refinement for structured collections
    cols.push(`"${name}" ${PG_TYPE[f.type!]}${pk}`);
  }
  let ddl = `create table if not exists ${schema}.${collection} (${cols.join(", ")});`;
  // Re-apply upgrade path for newly bound vocabularies on a pre-existing table.
  // Each vocabulary slug is config-validated, so identifier interpolation is safe.
  for (const taxSlug of c.taxonomies ?? []) {
    const vocab = cfg.taxonomies[taxSlug];
    const colType = vocab?.multiple ? "text[]" : "text";
    ddl += ` alter table ${schema}.${collection} add column if not exists "${taxSlug}" ${colType};`;
    // A multi-value term column is only ever queried with `&&`/`= any`, which needs GIN.
    if (vocab?.multiple)
      ddl += ` create index if not exists "${collection}_${taxSlug}_idx"`
        + ` on ${schema}.${collection} using gin ("${taxSlug}");`;
  }
  return ddl;
}

// One flat view per collection/env. Joins resolve view_join columns.
export function viewDDL(env: "dev" | "live", collection: string, cfg: WarehousdConfig): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);

  if (c.type === "file") {
    // Each bound vocabulary gets selected from the files table
    const termSels = (c.taxonomies ?? []).map(taxSlug => `, d."${taxSlug}"`).join("");
    return `create or replace view ${schema}.v_${collection} as
      select c.id as document_id, c.document_seq, c.content, c.tsv,
             d.id as file_id, d.title, d.path, d.owner, d.updated_at${termSels}
      from ${schema}."${collection}__documents" c
      join ${schema}."${collection}__files" d on d.id = c.file_id;`;
  }

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

// The import role writes live BASE tables (not views — a view insert would need rules) and
// gets nothing else: no SELECT, no UPDATE, no DELETE, and nothing at all in data_synth.
// Synthetic data is generated, never imported, so there is no dev counterpart by design.
export function grantImportDDL(collection: string, cfg: WarehousdConfig): string {
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  // File collections are populated by the indexer under the owner role, not by import.
  if (c.type === "file") return "";
  return `grant insert on data_live.${collection} to warehousd_import;`;
}
