import type { WarehousdConfig } from "../config/schema";
import { fileMetadataFields } from "../config/schema";

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
    // Extra typed metadata fields declared on the file collection.
    const metadataCols: string[] = [];
    const metadataAlters: string[] = [];
    for (const m of fileMetadataFields(c)) {
      const colType = PG_TYPE[m.type];
      metadataCols.push(`\n        "${m.field}" ${colType}`);
      metadataAlters.push(`\n      alter table ${schema}."${collection}__files" add column if not exists "${m.field}" ${colType};`);
    }
    const termCol = termCols.length > 0 ? termCols.join(",") + "," : "";
    const metadataCol = metadataCols.length > 0 ? metadataCols.join(",") + "," : "";
    const termAlter = termAlters.length > 0 ? termAlters.join("") : "";
    const metadataAlter = metadataAlters.length > 0 ? metadataAlters.join("") : "";
    return `
      create table if not exists ${schema}."${collection}__files" (
        id uuid primary key,
        title text,
        path text not null unique,${termCol}${metadataCol}
        owner text,
        checksum text not null,
        updated_at timestamptz not null);${termAlter}${metadataAlter}
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

  // CollectionSchema's transform materialises every bound vocabulary as a text field, so the
  // taxonomy slugs are already in `c.fields`. The vocabulary loop below owns their columns —
  // it is the only place that knows a `multiple` vocabulary needs text[] — so they are taken
  // from there rather than from the field's declared type.
  const boundVocabs = new Set(c.taxonomies ?? []);
  const cols: string[] = [];
  const fieldAlters: string[] = [];
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.view_join) continue; // join columns are not stored on the base table
    const pk = f.pk ? " primary key" : "";
    // type is guaranteed by CollectionSchema refinement for structured collections
    const colType = boundVocabs.has(name)
      ? (cfg.taxonomies[name]?.multiple ? "text[]" : "text") : PG_TYPE[f.type!];
    cols.push(`"${name}" ${colType}${pk}`);
    // Upgrade path for a field added to an already-created collection, mirroring what the
    // file branch does for its metadata fields — without this, `create table if not exists`
    // silently leaves the new column off an existing table. Field names are IDENT-validated
    // by CollectionSchema, so interpolation is as safe as the vocabulary loop below.
    // The pk is skipped: `add column` cannot add one, and a pk only exists on a table this
    // statement is creating for the first time.
    if (!f.pk && !boundVocabs.has(name))
      fieldAlters.push(` alter table ${schema}.${collection} add column if not exists "${name}" ${PG_TYPE[f.type!]};`);
  }
  let ddl = `create table if not exists ${schema}.${collection} (${cols.join(", ")});`;
  ddl += fieldAlters.join("");
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
//
// Dropped and recreated rather than `create or replace`d: replace may only append columns,
// so a field added anywhere but the end of the YAML fails with `cannot change name of view
// column`. Two statements in one query string run in a single implicit transaction, so the
// view is never briefly absent, and applyConfig re-issues grantViewDDL straight afterwards —
// which is the only thing that grants on these views.
export function viewDDL(env: "dev" | "live", collection: string, cfg: WarehousdConfig): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  const recreate = `drop view if exists ${schema}.v_${collection};
    create view ${schema}.v_${collection} as`;

  if (c.type === "file") {
    // Each bound vocabulary and metadata field gets selected from the files table
    const termSels = (c.taxonomies ?? []).map(taxSlug => `, d."${taxSlug}"`).join("");
    const metadataSels = fileMetadataFields(c).map((m) => `, d."${m.field}"`).join("");
    return `${recreate}
      select c.id as document_id, c.document_seq, c.content, c.tsv,
             d.id as file_id, d.title, d.path, d.owner, d.updated_at${termSels}${metadataSels}
      from ${schema}."${collection}__documents" c
      join ${schema}."${collection}__files" d on d.id = c.file_id;`;
  }

  const selects: string[] = [];
  const joins: string[] = [];
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.view_join) {
      const { table: jt, column: jc, on: onField } = f.view_join;
      const alias = `j_${name}`;
      joins.push(`left join ${schema}."${jt}" ${alias} on ${alias}.id = base."${onField}"`);
      selects.push(`${alias}."${jc}" as "${name}"`);
    } else {
      selects.push(`base."${name}"`);
    }
  }
  return `${recreate}
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
