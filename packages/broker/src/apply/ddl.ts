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
    // c.taxonomy is a config-validated vocabulary slug — identifier interpolation is safe.
    const termCol = c.taxonomy ? `\n        "${c.taxonomy}" text,` : "";
    const termAlter = c.taxonomy
      ? `\n      alter table ${schema}."${collection}__files" add column if not exists "${c.taxonomy}" text;` : "";
    return `
      create table if not exists ${schema}."${collection}__files" (
        id uuid primary key,
        org_id text not null default 'default',
        title text,
        path text not null unique,${termCol}
        owner text,
        checksum text not null,
        updated_at timestamptz not null);
      alter table ${schema}."${collection}__files" add column if not exists org_id text not null default 'default';${termAlter}
      create table if not exists ${schema}."${collection}__documents" (
        id uuid primary key,
        org_id text not null default 'default',
        file_id uuid not null references ${schema}."${collection}__files"(id) on delete cascade,
        document_seq int not null,
        content text not null,
        tsv tsvector generated always as (to_tsvector('english', content)) stored,
        embedding vector(1536),
        unique (file_id, document_seq));
      alter table ${schema}."${collection}__documents" add column if not exists org_id text not null default 'default';
      create index if not exists "${collection}__documents_tsv_idx"
        on ${schema}."${collection}__documents" using gin (tsv);
    `;
  }

  const cols: string[] = [];
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.view_join) continue; // join columns are not stored on the base table
    const pk = f.pk ? " primary key" : "";
    // type is guaranteed by CollectionSchema refinement for structured collections
    cols.push(`"${name}" ${PG_TYPE[f.type!]}${pk}`);
  }
  let ddl = `create table if not exists ${schema}.${collection} (org_id text not null default 'default', ${cols.join(", ")});`;
  ddl += ` alter table ${schema}.${collection} add column if not exists org_id text not null default 'default';`;
  // Re-apply upgrade path for a newly bound taxonomy on a pre-existing table.
  // c.taxonomy is a config-validated vocabulary slug — identifier interpolation is safe.
  if (c.taxonomy) ddl += ` alter table ${schema}.${collection} add column if not exists "${c.taxonomy}" text;`;

  // Add tsvector columns and indexes for searchable fields (dataset only)
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.searchable) {
      ddl += `\n      alter table ${schema}.${collection} add column if not exists "${name}_tsv" tsvector generated always as (to_tsvector('english', coalesce("${name}", ''))) stored;`;
      ddl += `\n      create index if not exists "${collection}_${name}_tsv_idx" on ${schema}.${collection} using gin ("${name}_tsv");`;
    }
  }
  return ddl;
}

// One flat view per collection/env. Joins resolve view_join columns.
// Views filter by current_setting('warehousd.org_id') — the database enforces org isolation,
// so broker-built SQL never carries an org predicate (see Phase 1 acceptance criterion).
export function viewDDL(env: "dev" | "live", collection: string, cfg: WarehousdConfig): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);

  if (c.type === "file") {
    // c.taxonomy is a config-validated vocabulary slug — identifier interpolation is safe.
    const termSel = c.taxonomy ? `, d."${c.taxonomy}"` : "";
    return `create or replace view ${schema}.v_${collection} as
      select c.id as document_id, c.document_seq, c.content, c.tsv,
             d.id as file_id, d.title, d.path, d.owner, d.updated_at${termSel}
      from ${schema}."${collection}__documents" c
      join ${schema}."${collection}__files" d on d.id = c.file_id and d.org_id = c.org_id
      where d.org_id = current_setting('warehousd.org_id', true);`;
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
      // Include tsvector columns for searchable fields; they're not in the grantable set
      if (f.searchable) selects.push(`base."${name}_tsv"`);
    }
  }
  return `create or replace view ${schema}.v_${collection} as
    select ${selects.join(", ")} from ${schema}.${collection} base ${joins.join(" ")}
    where base.org_id = current_setting('warehousd.org_id', true);`;
}

export function grantViewDDL(env: "dev" | "live", collection: string): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const role = env === "dev" ? "warehousd_dev" : "warehousd_live";
  return `grant select on ${schema}.v_${collection} to ${role};`;
}

// Org isolation has two walls, and neither is redundant. The read roles only ever see the
// view, whose WHERE predicate is the wall for them. Roles that touch base tables directly —
// warehousd_import today, the write roles later — bypass the view entirely, so RLS is their
// wall. Both live in the database, so a broker bug cannot cross the tenant boundary either way.
export function rlsDDL(env: "dev" | "live", collection: string, cfg: WarehousdConfig): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);

  const tables: string[] = [];
  if (c.type === "file") {
    tables.push(`${schema}."${collection}__files"`, `${schema}."${collection}__documents"`);
  } else {
    tables.push(`${schema}.${collection}`);
  }

  return tables.map((t) => `
    alter table ${t} enable row level security;
    drop policy if exists org_isolation on ${t};
    create policy org_isolation on ${t}
      using (org_id = current_setting('warehousd.org_id', true))
      with check (org_id = current_setting('warehousd.org_id', true));
  `).join("");
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
