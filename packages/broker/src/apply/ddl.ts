import type { WarehousdConfig } from "../config/schema";
import { fileMetadataFields } from "../config/schema";

// The width of the embedding column when no `embedding:` block is configured. Matches the
// default local model (bge-small-en-v1.5), so turning semantic search on later with the default
// provider needs no column rebuild.
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

const PG_TYPE: Record<string, string> = {
  uuid: "uuid",
  text: "text",
  numeric: "numeric",
  int: "integer",
  timestamptz: "timestamptz",
  date: "date",
  boolean: "boolean",
  json: "jsonb",
};

// The revision columns EVERY dataset carries. Structural: no field declares them, no grant can
// name them, and no schema change can strand data in one.
const REV_COLS = [
  "_rev",
  "_rev_seq",
  "_rev_at",
  "_rev_by",
  "_rev_op",
  "_rev_status",
  "_rev_fields",
  "_rev_base",
  "_current",
] as const;

export type DeclaredColumn = { name: string; pgType: string; pk: boolean };

/**
 * What a table is supposed to look like, split into the columns the YAML declares and the ones
 * the DDL owns.
 *
 * Only `columns` can hold data a config change would strand, so only `columns` is compared
 * against the live database in `plan.ts` — `structural` exists so the planner can tell a column
 * it is not responsible for from one the operator deleted. This is the single source of truth
 * for the mapping: `tableDDL` builds its `create table` list from it rather than repeating the
 * "a bound vocabulary is text, or text[] when it is `multiple`" rule a second time.
 */
export type DeclaredTable = { table: string; columns: DeclaredColumn[]; structural: string[] };

export function declaredTables(collection: string, cfg: WarehousdConfig): DeclaredTable[] {
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);

  if (c.type === "file") {
    const columns: DeclaredColumn[] = [];
    for (const taxSlug of c.taxonomies ?? [])
      columns.push({
        name: taxSlug,
        pgType: cfg.taxonomies[taxSlug]?.multiple ? "text[]" : "text",
        pk: false,
      });
    for (const m of fileMetadataFields(c))
      columns.push({ name: m.field, pgType: PG_TYPE[m.type]!, pk: false });
    return [
      {
        table: `${collection}__files`,
        columns,
        structural: [
          "id",
          "org_id",
          "title",
          "path",
          "owner",
          "checksum",
          "updated_at",
          // The uploaded original and its shape. Structural because no field declares them:
          // they are what the indexer stored, not something the YAML asked for.
          "content_type",
          "byte_size",
          "blob",
        ],
      },
      {
        table: `${collection}__documents`,
        columns: [],
        structural: ["id", "org_id", "file_id", "document_seq", "content", "tsv", "embedding"],
      },
    ];
  }

  const boundVocabs = new Set(c.taxonomies ?? []);
  const columns: DeclaredColumn[] = [];
  // Unconditional, matching tableDDL. Gating this on `writable` would make the planner read
  // every non-writable dataset's `_rev*` columns as data the operator deleted, and refuse to
  // apply a config that had not changed at all.
  const structural: string[] = ["org_id", ...REV_COLS];
  for (const [name, f] of Object.entries(c.fields)) {
    // Join columns are resolved in the view and stored nowhere, so nothing can be stranded in one.
    if (f.view_join) continue;
    const pgType = boundVocabs.has(name)
      ? cfg.taxonomies[name]?.multiple
        ? "text[]"
        : "text"
      : PG_TYPE[f.type!]!;
    columns.push({ name, pgType, pk: !!f.pk });
    // Structural for every field, not just a `searchable` one. A `<field>_tsv` column is always
    // generated — it holds nothing that is not derived from `<field>` — so a field that stops
    // being searchable leaves one behind that must not be reported as data the operator deleted.
    // A field genuinely *declared* as `<name>_tsv` is unaffected: it is in `columns`, which is
    // what drives type and addition planning; `structural` only suppresses drop detection.
    structural.push(`${name}_tsv`);
  }
  return [{ table: collection, columns, structural }];
}

/**
 * The field the declared primary key sits on, or null when the collection declares none.
 *
 * A writable dataset's real primary key is `_rev` — the declared pk becomes document identity,
 * carried by the `<collection>_current_idx` unique index instead. Both cases answer the same
 * question, so both come from here.
 */
export function declaredPkField(collection: string, cfg: WarehousdConfig): string | null {
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  if (c.type === "file") return null;
  for (const [name, f] of Object.entries(c.fields)) if (f.pk) return name;
  return null;
}

export function tableDDL(env: "dev" | "live", collection: string, cfg: WarehousdConfig): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);

  // An external collection's live rows are the remote system's; the foreign table stands in for
  // a base table. Dev is generated as usual — that is what keeps env parity true, and what keeps
  // a developer's queries off someone else's production database.
  if (c.source_ref && env === "live") return "";

  if (c.type === "file") {
    // Each bound vocabulary gets a column (text or text[] depending on cardinality)
    const termCols: string[] = [];
    const termAlters: string[] = [];
    for (const taxSlug of c.taxonomies ?? []) {
      const vocab = cfg.taxonomies[taxSlug];
      const colType = vocab?.multiple ? "text[]" : "text";
      termCols.push(`\n        "${taxSlug}" ${colType}`);
      termAlters.push(
        `\n      alter table ${schema}."${collection}__files" add column if not exists "${taxSlug}" ${colType};`,
      );
      // A multi-value term column is only ever queried with `&&`/`= any`, which needs GIN.
      if (vocab?.multiple)
        termAlters.push(
          `\n      create index if not exists "${collection}__files_${taxSlug}_idx"` +
            ` on ${schema}."${collection}__files" using gin ("${taxSlug}");`,
        );
    }
    // Extra typed metadata fields declared on the file collection.
    const metadataCols: string[] = [];
    const metadataAlters: string[] = [];
    for (const m of fileMetadataFields(c)) {
      const colType = PG_TYPE[m.type];
      metadataCols.push(`\n        "${m.field}" ${colType}`);
      metadataAlters.push(
        `\n      alter table ${schema}."${collection}__files" add column if not exists "${m.field}" ${colType};`,
      );
    }
    const termCol = termCols.length > 0 ? termCols.join(",") + "," : "";
    const metadataCol = metadataCols.length > 0 ? metadataCols.join(",") + "," : "";
    const termAlter = termAlters.length > 0 ? termAlters.join("") : "";
    const metadataAlter = metadataAlters.length > 0 ? metadataAlters.join("") : "";
    // The embedding column's width comes from the config, because it has to match the model.
    // Absent config still creates the column — semantic search can be turned on later without a
    // table rebuild — at the dimension of the default local model.
    const dims = cfg.embedding?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    // HNSW rather than IVFFlat: IVFFlat has to be built over existing rows to pick its lists, so
    // creating it here — on an empty table, before anything is indexed — would produce an index
    // that never recovers. HNSW needs no training pass and stays correct as rows arrive.
    // `vector_cosine_ops` matches the normalised vectors the embedders return.
    return `
      create table if not exists ${schema}."${collection}__files" (
        id uuid primary key,
        org_id text not null default 'default',
        title text,
        path text not null unique,${termCol}${metadataCol}
        owner text,
        checksum text not null,
        updated_at timestamptz not null);
      alter table ${schema}."${collection}__files" add column if not exists org_id text not null default 'default';${termAlter}${metadataAlter}
      alter table ${schema}."${collection}__files" add column if not exists content_type text;
      alter table ${schema}."${collection}__files" add column if not exists byte_size integer;
      alter table ${schema}."${collection}__files" add column if not exists blob bytea;
      create table if not exists ${schema}."${collection}__documents" (
        id uuid primary key,
        org_id text not null default 'default',
        file_id uuid not null references ${schema}."${collection}__files"(id) on delete cascade,
        document_seq int not null,
        content text not null,
        tsv tsvector generated always as (to_tsvector('english', content)) stored,
        embedding vector(${dims}),
        unique (file_id, document_seq));
      alter table ${schema}."${collection}__documents" add column if not exists org_id text not null default 'default';
      create index if not exists "${collection}__documents_tsv_idx"
        on ${schema}."${collection}__documents" using gin (tsv);
      create index if not exists "${collection}__documents_embedding_idx"
        on ${schema}."${collection}__documents" using hnsw (embedding vector_cosine_ops);
    `;
  }

  // CollectionSchema's transform materialises every bound vocabulary as a text field, so the
  // taxonomy slugs are already in `c.fields`. declaredTables owns their type — it is the only
  // place that knows a `multiple` vocabulary needs text[] — so it is taken from there rather
  // than from the field's declared type.
  const boundVocabs = new Set(c.taxonomies ?? []);
  // The column list, and the type of each, comes from declaredTables — the same function the
  // schema planner compares against the live database, so the DDL and the planner cannot drift
  // apart on what a field's Postgres type is meant to be.
  const cols = declaredTables(collection, cfg)[0]!.columns.map(
    (col) => `"${col.name}" ${col.pgType}${col.pk ? " primary key" : ""}`,
  );
  const fieldAlters: string[] = [];
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.view_join) continue; // join columns are not stored on the base table
    // Upgrade path for a field added to an already-created collection, mirroring what the
    // file branch does for its metadata fields — without this, `create table if not exists`
    // silently leaves the new column off an existing table. Field names are IDENT-validated
    // by CollectionSchema, so interpolation is as safe as the vocabulary loop below.
    // The pk is skipped: `add column` cannot add one, and a pk only exists on a table this
    // statement is creating for the first time.
    if (!f.pk && !boundVocabs.has(name))
      fieldAlters.push(
        ` alter table ${schema}.${collection} add column if not exists "${name}" ${PG_TYPE[f.type!]};`,
      );
  }
  // Re-apply upgrade path for newly bound vocabularies on a pre-existing table.
  // Each vocabulary slug is config-validated, so identifier interpolation is safe.
  let vocabAlters = "";
  for (const taxSlug of c.taxonomies ?? []) {
    const vocab = cfg.taxonomies[taxSlug];
    const colType = vocab?.multiple ? "text[]" : "text";
    vocabAlters += ` alter table ${schema}.${collection} add column if not exists "${taxSlug}" ${colType};`;
    // A multi-value term column is only ever queried with `&&`/`= any`, which needs GIN.
    if (vocab?.multiple)
      vocabAlters +=
        ` create index if not exists "${collection}_${taxSlug}_idx"` +
        ` on ${schema}.${collection} using gin ("${taxSlug}");`;
  }

  // Add tsvector columns and indexes for searchable fields (dataset only)
  let searchAlters = "";
  for (const [name, f] of Object.entries(c.fields)) {
    if (!f.searchable) continue;
    searchAlters += `\n      alter table ${schema}.${collection} add column if not exists "${name}_tsv" tsvector generated always as (to_tsvector('english', coalesce("${name}", ''))) stored;`;
    searchAlters += `\n      create index if not exists "${collection}_${name}_tsv_idx" on ${schema}.${collection} using gin ("${name}_tsv");`;
  }

  // EVERY dataset gets revision columns, and the declared pk becomes document identity rather
  // than a table constraint.
  //
  // This used to be gated on `writable`, which tied "can a client write this?" to "is this table
  // append-only?" — two different questions. The admin import path needs update and delete, and
  // the only way to have those without granting the import role UPDATE and DELETE on data columns
  // is for both to be new revisions. So revisions are structural now, and `writable` gates only
  // the client write path (broker.mutate) as its name says.
  //
  // The pk field name for the unique index on _current. `id` when none is declared, which is
  // the fallback this has always used.
  const pkField = declaredPkField(collection, cfg) ?? "id";

  // `superseded` is the status of a pending revision that an approval merged into a new one
  // rather than promoting in place. approveProposal has to write a merged row — the current
  // document may have moved on in fields the proposal did not touch, and per the design a stale
  // base with no overlap still promotes — so the pending row it consumed has to be marked as
  // something that is not history. It used to be flipped to `approved`, which left two approved
  // rows carrying the same `_rev_fields`, duplicating the document's history and giving two rows
  // the same `_rev_seq`. The row is kept rather than deleted: it is the immutable record of what
  // was proposed, as distinct from what was applied, and the write role has no DELETE anyway.
  const statusValues = `'pending','approved','rejected','superseded'`;
  const statusCheck = `${collection}__rev_status_check`;
  const revCols = `
        _rev        uuid primary key default gen_random_uuid(),
        _rev_seq    bigint      not null,
        _rev_at     timestamptz not null default now(),
        _rev_by     text        not null,
        _rev_op     text        not null check (_rev_op in ('create','update','delete')),
        _rev_status text        not null constraint "${statusCheck}" check (_rev_status in (${statusValues})),
        _rev_fields text[]      not null,
        _rev_base   bigint,
        _current    boolean     not null default false,
        org_id      text        not null default 'default',`;
  // Remove pk constraint from data columns
  const dataColsNoPk = cols.map((col) => col.replace(/ primary key$/, ""));
  let ddl = `create table if not exists ${schema}.${collection} (${revCols} ${dataColsNoPk.join(", ")});`;
  ddl += ` alter table ${schema}.${collection} add column if not exists org_id text not null default 'default';`;
  // `create table if not exists` is a no-op on a table that predates a value being added to the
  // check, so the constraint is re-asserted explicitly. Naming it means the drop/add pair is
  // idempotent whether the constraint was created inline here or auto-named by Postgres — the
  // generated name for this column is the same string.
  ddl += ` alter table ${schema}.${collection} drop constraint if exists "${statusCheck}";`;
  ddl += ` alter table ${schema}.${collection} add constraint "${statusCheck}" check (_rev_status in (${statusValues}));`;
  ddl += ` create unique index if not exists "${collection}_current_idx" on ${schema}.${collection} (org_id, "${pkField}") where _current;`;
  ddl += fieldAlters.join("");
  ddl += vocabAlters;
  ddl += searchAlters;
  return ddl;
}

// One flat view per collection/env. Joins resolve view_join columns.
//
// Dropped and recreated rather than `create or replace`d: replace may only append columns,
// so a field added anywhere but the end of the YAML fails with `cannot change name of view
// column`. Two statements in one query string run in a single implicit transaction, so the
// view is never briefly absent, and applyConfig re-issues grantViewDDL straight afterwards —
// which is the only thing that grants on these views.
//
// Views filter by current_setting('warehousd.org_id') — the database enforces org isolation,
// so broker-built SQL never carries an org predicate (see Phase 1 acceptance criterion).
// For writable datasets, the view also filters to _current=true and _rev_op<>'delete' —
// pending revisions never appear, so unapproved agent output cannot leak into ordinary queries.
export function viewDDL(env: "dev" | "live", collection: string, cfg: WarehousdConfig): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  const recreate = `drop view if exists ${schema}.v_${collection};
    create view ${schema}.v_${collection} as`;

  if (c.type === "file") {
    // Each bound vocabulary and metadata field gets selected from the files table
    const termSels = (c.taxonomies ?? []).map((taxSlug) => `, d."${taxSlug}"`).join("");
    const metadataSels = fileMetadataFields(c)
      .map((m) => `, d."${m.field}"`)
      .join("");
    // `checksum` is structural, like document_seq and file_id: it names no configured field, so
    // no grant can carry it and no client intent can select it (buildSelect draws its columns
    // from the YAML field set). It is here because it is the indexer's change-detection key, and
    // the console's file inventory reads this view — the read role holds SELECT on nothing else.
    // `embedding` joins `tsv` and `checksum` as a structural column: it names no configured
    // field, so no grant can carry it and buildSelect can never project it — its columns come
    // from the YAML field set. It is here because the read role holds SELECT on this view and
    // nothing else, and a semantic search has to be able to rank by it.
    return `${recreate}
      select c.id as document_id, c.document_seq, c.content, c.tsv, c.embedding,
             d.id as file_id, d.title, d.path, d.owner, d.updated_at, d.checksum${termSels}${metadataSels}
      from ${schema}."${collection}__documents" c
      join ${schema}."${collection}__files" d on d.id = c.file_id and d.org_id = c.org_id
      where d.org_id = current_setting('warehousd.org_id', true);`;
  }

  // An external collection's live view reads the foreign table. It has no org_id column — the
  // remote system knows nothing about warehousd's tenants — so the predicate compares the
  // request's org against the constant the config declared for this source. That is a genuine
  // narrowing of the two-wall model: RLS cannot apply to a foreign table, so this predicate is
  // the only wall. It is stated in docs/architecture.md and SECURITY.md rather than left implicit.
  if (c.source_ref && env === "live") {
    const cols = Object.entries(c.fields)
      .filter(([, f]) => !f.view_join)
      .map(([name]) => `base."${name}"`);
    return `${recreate}
      select ${cols.join(", ")} from ${schema}."_ext_${collection}" base
      where current_setting('warehousd.org_id', true) = '${c.source_ref.org.replace(/'/g, "''")}';`;
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
      // Include tsvector columns for searchable fields; they're not in the grantable set
      if (f.searchable) selects.push(`base."${name}_tsv"`);
    }
  }

  // Every dataset is revisioned, so every dataset view shows the current, non-tombstoned
  // revision and nothing else. Pending revisions never appear — unapproved agent output cannot
  // leak into an ordinary query — and neither does a document a delete revision retired, whether
  // that delete came from the write path or from an admin import.
  const whereClause = `where base.org_id = current_setting('warehousd.org_id', true) and base._current and base._rev_op <> 'delete'`;

  return `${recreate}
    select ${selects.join(", ")} from ${schema}.${collection} base ${joins.join(" ")}
    ${whereClause};`;
}

// The foreign table an external collection reads through, plus the server and user mapping it
// needs. Live only: `dev` gets an ordinary synthetic table like every other collection, so a
// developer never touches the external system and invariant 6 (env parity) still holds.
//
// Three properties are enforced by the DATABASE here rather than by broker code:
//
//   - Read-only. `updatable 'false'` on both server and table, and no role is granted anything
//     but SELECT on the wrapping view. `mutate` also refuses structurally, but that is the
//     second line, not the first.
//   - The exact column set. Columns are declared from the YAML, one CREATE FOREIGN TABLE at a
//     time, rather than imported wholesale — so a column added upstream is invisible to
//     warehousd until someone writes it down here.
//   - The credential's blast radius. It lives in a user mapping, readable only by its owner, and
//     never in a warehousd table.
export function foreignTableDDL(collection: string, cfg: WarehousdConfig): string {
  const c = cfg.collections[collection];
  if (!c?.source_ref) return "";
  const src = cfg.sources[c.source_ref.source];
  if (!src) throw new Error(`Unknown source: ${c.source_ref.source}`);

  const server = `wh_src_${c.source_ref.source}`;
  const foreign = `data_live."_ext_${collection}"`;
  const u = new URL(src.url);
  const port = u.port || "5432";
  const database = u.pathname.replace(/^\//, "");
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  // Single-quoted FDW option values. Every one of these comes from warehousd.yml (via ${env:VAR}),
  // never from a request, and a quote inside one would end the literal — so they are escaped
  // rather than trusted, the same rule param() keeps for values on the query path.
  const q1 = (v: string) => `'${v.replace(/'/g, "''")}'`;

  const cols = Object.entries(c.fields)
    .filter(([, f]) => !f.view_join)
    .map(([name, f]) => {
      const pgType = (c.taxonomies ?? []).includes(name)
        ? cfg.taxonomies[name]?.multiple
          ? "text[]"
          : "text"
        : PG_TYPE[f.type!];
      // `column_name` maps a differing remote name onto the field name, so everything downstream
      // — view, grant, buildSelect — sees the name the YAML declared.
      const opt = f.column ? ` options (column_name ${q1(f.column)})` : "";
      return `"${name}" ${pgType}${opt}`;
    });

  return `
    do $$ begin
      if not exists (select 1 from pg_foreign_server where srvname = '${server}') then
        execute format('create server %I foreign data wrapper postgres_fdw options (host %L, port %L, dbname %L, updatable %L, fetch_size %L)',
          '${server}', ${q1(u.hostname)}, ${q1(port)}, ${q1(database)}, 'false', '1000');
      end if;
    end $$;
    do $$ begin
      if not exists (
        select 1 from pg_user_mappings
        where srvname = '${server}' and (usename = current_user or usename is null)
      ) then
        execute format('create user mapping for current_user server %I options (user %L, password %L)',
          '${server}', ${q1(user)}, ${q1(password)});
      end if;
    end $$;
    drop foreign table if exists ${foreign} cascade;
    create foreign table ${foreign} (${cols.join(", ")})
      server ${server}
      options (schema_name ${q1(src.schema)}, table_name ${q1(c.source_ref.table)}, updatable 'false');
  `;
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

  // A foreign table cannot carry an RLS policy, and there is no local row to police. The view's
  // constant org predicate is the wall for these — see viewDDL.
  if (c.source_ref && env === "live") return "";

  const tables: string[] = [];
  if (c.type === "file") {
    tables.push(`${schema}."${collection}__files"`, `${schema}."${collection}__documents"`);
  } else {
    tables.push(`${schema}.${collection}`);
  }

  return tables
    .map(
      (t) => `
    alter table ${t} enable row level security;
    drop policy if exists org_isolation on ${t};
    create policy org_isolation on ${t}
      using (org_id = current_setting('warehousd.org_id', true))
      with check (org_id = current_setting('warehousd.org_id', true));
  `,
    )
    .join("");
}

// The import role writes live BASE tables (not views — a view insert would need rules) and
// nothing at all in data_synth. Synthetic data is generated, never imported, so there is no dev
// counterpart by design.
//
// Its privileges are exactly the write role's, and for the same reason: import's update and
// delete modes are new REVISIONS, so what they need is INSERT plus the ability to retire the row
// they supersede. It holds **no UPDATE on any data column and no DELETE at all** — an import
// cannot rewrite or destroy a value that is already in data_live, only append the revision that
// replaces it. Immutability here is a privilege, not a code path that could be bypassed.
//
// SELECT is needed to find the current revision to supersede, and to answer a dry run.
export function grantImportDDL(collection: string, cfg: WarehousdConfig): string {
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  // File collections are populated by the indexer under the owner role, not by import.
  if (c.type === "file") return "";
  // An external collection's rows belong to the remote system. Import writes data_live tables,
  // and there is no data_live table here to write.
  if (c.source_ref) return "";
  return `
grant insert on data_live.${collection} to warehousd_import;
grant update (_current, _rev_status) on data_live.${collection} to warehousd_import;
grant select on data_live.${collection} to warehousd_import;
  `.trim();
}

// Write roles can insert, can select base table (for concurrency/merge), can update only
// _current and _rev_status (promotion columns). No DELETE privilege ever. Immutability is
// enforced by privilege, not by application code.
export function grantWriteDDL(
  env: "dev" | "live",
  collection: string,
  cfg: WarehousdConfig,
): string {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const role = env === "dev" ? "warehousd_dev_write" : "warehousd_live_write";
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);

  if (!c.writable) return "";

  if (c.type === "file") {
    return `grant insert on ${schema}."${collection}__files", ${schema}."${collection}__documents" to ${role};`;
  }

  // Dataset: insert all, update only promotion columns, select base table for concurrency checks
  return `
grant insert on ${schema}.${collection} to ${role};
grant update (_current, _rev_status) on ${schema}.${collection} to ${role};
grant select on ${schema}.${collection} to ${role};
  `.trim();
}
