import type { WarehousdConfig } from "../config/schema";
import type { Queryable } from "../db/queryable";
import { declaredTables, declaredPkField, type DeclaredColumn } from "./ddl";

/**
 * What separates a change `applyConfig` can make on its own from one that needs a human.
 *
 * `applyConfig` is additive and always has been: `create table if not exists` plus
 * `add column if not exists`. That is what makes it safe to run on every boot, and it is why a
 * field type change is silently ignored today — the column keeps its old type while
 * `app.collections.config` records the new one, and the broker then builds SQL against a type the
 * column does not have. This module is the part that notices.
 */
export type ChangeKind =
  "add_column" | "type_change" | "drop_column" | "pk_change" | "drop_collection";

export type SchemaChange = {
  collection: string;
  env: "dev" | "live";
  table: string;
  kind: ChangeKind;
  /** The field the change is about; null for a whole-collection change. */
  field: string | null;
  from: string | null;
  to: string | null;
  /** false ⇒ applyConfig's existing additive DDL already covers it. */
  destructive: boolean;
  /** true ⇒ the cast can lose data, so a human has to write the USING. */
  reviewRequired: boolean;
  /** A USING expression that is correct when reviewRequired is false, a starting point when it is. */
  using: string | null;
  detail: string;
};

// Casts that cannot lose anything. Everything absent from this set is treated as lossy, which is
// the safe direction to be wrong in: the worst case is that an operator reviews a migration that
// did not strictly need reviewing.
//
// `text → text[]` belongs here because it is how a vocabulary becomes `multiple: true`, and
// wrapping a scalar in a one-element array keeps every value. The reverse does not: collapsing an
// array to one value is exactly the data loss this whole module exists to catch.
const LOSSLESS = new Set([
  "integer→numeric",
  "integer→text",
  "numeric→text",
  "uuid→text",
  "boolean→text",
  "date→text",
  "timestamptz→text",
  "jsonb→text",
  "date→timestamptz",
  "text→text[]",
]);

/**
 * The USING expression for a cast, and whether a human needs to look at it.
 *
 * Pure: no database, no config. This is the part worth testing exhaustively.
 */
export function classifyCast(
  from: string,
  to: string,
  column: string,
): { reviewRequired: boolean; using: string } {
  const c = `"${column}"`;
  if (from === "text" && to === "text[]")
    return {
      reviewRequired: false,
      using: `case when ${c} is null then null else array[${c}] end`,
    };
  if (from === "text[]" && to === "text")
    return { reviewRequired: true, using: `array_to_string(${c}, ',')` };
  return { reviewRequired: !LOSSLESS.has(`${from}→${to}`), using: `${c}::${to}` };
}

function typeChange(
  collection: string,
  env: "dev" | "live",
  table: string,
  col: DeclaredColumn,
  actual: string,
): SchemaChange {
  const { reviewRequired, using } = classifyCast(actual, col.pgType, col.name);
  return {
    collection,
    env,
    table,
    kind: "type_change",
    field: col.name,
    from: actual,
    to: col.pgType,
    destructive: true,
    reviewRequired,
    using,
    detail: `${collection}.${col.name} is ${actual} in the database and ${col.pgType} in warehousd.yml`,
  };
}

function dropColumn(
  collection: string,
  env: "dev" | "live",
  table: string,
  column: string,
  actual: string,
): SchemaChange {
  return {
    collection,
    env,
    table,
    kind: "drop_column",
    field: column,
    from: actual,
    to: null,
    destructive: true,
    reviewRequired: true,
    using: null,
    detail:
      `${collection}.${column} exists in the database but no longer in warehousd.yml. ` +
      `If it was renamed, rename the column instead of dropping it.`,
  };
}

function addColumn(
  collection: string,
  env: "dev" | "live",
  table: string,
  col: DeclaredColumn,
): SchemaChange {
  return {
    collection,
    env,
    table,
    kind: "add_column",
    field: col.name,
    from: null,
    to: col.pgType,
    destructive: false,
    reviewRequired: false,
    using: null,
    detail: `${collection}.${col.name} will be added as ${col.pgType}`,
  };
}

// information_schema reports the underlying type name, which is not what the DDL was written in.
// Normalise both ends onto the same vocabulary so a comparison means something.
function normalizeUdt(udtName: string, dataType: string): string {
  if (dataType === "ARRAY") return `${normalizeUdt(udtName.replace(/^_/, ""), "")}[]`;
  const map: Record<string, string> = {
    int4: "integer",
    int8: "bigint",
    int2: "smallint",
    bool: "boolean",
    timestamptz: "timestamptz",
    timestamp: "timestamp",
    varchar: "text",
    float8: "double precision",
  };
  return map[udtName] ?? udtName;
}

type ActualColumn = { schema: string; table: string; column: string; pgType: string };

async function reflectColumns(db: Queryable): Promise<ActualColumn[]> {
  const { rows } = await db.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
  }>(
    `select table_schema, table_name, column_name, data_type, udt_name
       from information_schema.columns
      where table_schema in ('data_synth','data_live')`,
  );
  return rows.map((r) => ({
    schema: r.table_schema,
    table: r.table_name,
    column: r.column_name,
    pgType: normalizeUdt(r.udt_name, r.data_type),
  }));
}

// The declared pk is a real primary key on a plain dataset, and the <collection>_current_idx
// unique index on a writable one (where _rev holds the primary key). Read both, so pk_change means
// the same thing either way.
async function reflectPk(db: Queryable): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const pk = await db.query<{ table_schema: string; table_name: string; column_name: string }>(
    `select tc.table_schema, tc.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.table_schema = tc.table_schema
      where tc.constraint_type = 'PRIMARY KEY'
        and tc.table_schema in ('data_synth','data_live')`,
  );
  for (const r of pk.rows) out.set(`${r.table_schema}.${r.table_name}`, r.column_name);

  const idx = await db.query<{ schemaname: string; tablename: string; indexdef: string }>(
    `select schemaname, tablename, indexdef from pg_indexes
      where schemaname in ('data_synth','data_live') and indexname like '%\\_current\\_idx'`,
  );
  for (const r of idx.rows) {
    // create unique index … on … (workspace_id, "field") where _current
    const m = /\(\s*workspace_id\s*,\s*"?([a-z0-9_]+)"?\s*\)/i.exec(r.indexdef);
    if (m?.[1]) out.set(`${r.schemaname}.${r.tablename}`, m[1]);
  }
  return out;
}

/**
 * Compare the config against the database as it actually is. Authoritative — this is what
 * `applyConfig` acts on, and the only producer that can see a column whose type drifted without
 * any config change to explain it.
 */
export async function planFromSchema(db: Queryable, cfg: WarehousdConfig): Promise<SchemaChange[]> {
  const actual = await reflectColumns(db);
  const pks = await reflectPk(db);
  const changes: SchemaChange[] = [];

  const byTable = new Map<string, ActualColumn[]>();
  for (const c of actual) {
    const key = `${c.schema}.${c.table}`;
    const list = byTable.get(key);
    if (list) list.push(c);
    else byTable.set(key, [c]);
  }

  for (const collection of Object.keys(cfg.collections)) {
    for (const env of ["dev", "live"] as const) {
      const schema = env === "dev" ? "data_synth" : "data_live";
      // An external collection has no LIVE table of its own to plan against — data_live holds a
      // foreign table whose shape belongs to the remote system, checked at apply time by
      // verifyExternalShape. Its dev table is an ordinary local one and is planned normally.
      if (env === "live" && cfg.collections[collection]?.source_ref) continue;
      for (const decl of declaredTables(collection, cfg)) {
        const existing = byTable.get(`${schema}.${decl.table}`);
        // A table that does not exist yet is not a change: applyConfig creates it.
        if (!existing) continue;
        const actualByName = new Map(existing.map((c) => [c.column, c.pgType]));

        for (const col of decl.columns) {
          const have = actualByName.get(col.name);
          if (have === undefined) changes.push(addColumn(collection, env, decl.table, col));
          else if (have !== col.pgType)
            changes.push(typeChange(collection, env, decl.table, col, have));
        }

        const known = new Set([...decl.columns.map((c) => c.name), ...decl.structural]);
        for (const c of existing)
          if (!known.has(c.column))
            changes.push(dropColumn(collection, env, decl.table, c.column, c.pgType));

        const wantPk = declaredPkField(collection, cfg);
        const havePk = pks.get(`${schema}.${decl.table}`);
        // Only a table this collection owns the pk of: __documents has its own, and a file
        // collection declares none.
        if (wantPk && havePk && havePk !== wantPk && decl.table === collection)
          changes.push({
            collection,
            env,
            table: decl.table,
            kind: "pk_change",
            field: wantPk,
            from: havePk,
            to: wantPk,
            destructive: true,
            reviewRequired: true,
            using: null,
            detail: `${collection} identifies documents by ${havePk} in the database and by ${wantPk} in warehousd.yml`,
          });
      }
    }
  }

  // A collection dropped from the YAML whose table is still there. app.collections is the registry
  // of what was applied, so it is what says "this used to be a collection" rather than guessing
  // from table names.
  //
  // 42P01 (undefined_table) is an answer, not a failure: a database that has never had migrateApp
  // run against it has no registry, and therefore genuinely has no dropped collections. Anything
  // else propagates — a connection that died must not read as "nothing was removed".
  const applied = await db
    .query<{ name: string }>(`select name from app.collections`)
    .catch((err: unknown) => {
      if ((err as { code?: string }).code === "42P01") return { rows: [] as { name: string }[] };
      throw err;
    });
  for (const { name } of applied.rows) {
    if (Object.hasOwn(cfg.collections, name)) continue;
    for (const env of ["dev", "live"] as const) {
      const schema = env === "dev" ? "data_synth" : "data_live";
      for (const table of [name, `${name}__files`]) {
        if (!byTable.has(`${schema}.${table}`)) continue;
        changes.push({
          collection: name,
          env,
          table,
          kind: "drop_collection",
          field: null,
          from: table,
          to: null,
          destructive: true,
          reviewRequired: true,
          using: null,
          detail: `collection ${name} is gone from warehousd.yml but ${schema}.${table} still exists`,
        });
      }
    }
  }

  return changes;
}

/**
 * Compare two configs. No database, so it cannot see drift and cannot count rows — but it works
 * where the database is unreachable, which is every `warehousd deploy` against a
 * `database.managed` Postgres. Fly generates those credentials and the CLI never holds them.
 */
export function planFromConfigs(prev: WarehousdConfig, next: WarehousdConfig): SchemaChange[] {
  const changes: SchemaChange[] = [];

  for (const collection of Object.keys(next.collections)) {
    if (!Object.hasOwn(prev.collections, collection)) continue;
    const prevTables = new Map(declaredTables(collection, prev).map((t) => [t.table, t]));

    for (const decl of declaredTables(collection, next)) {
      const before = prevTables.get(decl.table);
      if (!before) continue;
      const beforeByName = new Map(before.columns.map((c) => [c.name, c.pgType]));

      for (const col of decl.columns) {
        const had = beforeByName.get(col.name);
        // `env` is "live" because that is the one a config diff can say anything about: data_synth
        // is regenerated from the seed on every boot, so a change there is never a loss.
        if (had === undefined) changes.push(addColumn(collection, "live", decl.table, col));
        else if (had !== col.pgType)
          changes.push(typeChange(collection, "live", decl.table, col, had));
      }

      const kept = new Set(decl.columns.map((c) => c.name));
      for (const col of before.columns)
        if (!kept.has(col.name))
          changes.push(dropColumn(collection, "live", decl.table, col.name, col.pgType));
    }

    const wantPk = declaredPkField(collection, next);
    const hadPk = declaredPkField(collection, prev);
    if (wantPk && hadPk && wantPk !== hadPk)
      changes.push({
        collection,
        env: "live",
        table: collection,
        kind: "pk_change",
        field: wantPk,
        from: hadPk,
        to: wantPk,
        destructive: true,
        reviewRequired: true,
        using: null,
        detail: `${collection} identified documents by ${hadPk} and now by ${wantPk}`,
      });
  }

  for (const collection of Object.keys(prev.collections))
    if (!Object.hasOwn(next.collections, collection))
      changes.push({
        collection,
        env: "live",
        table: collection,
        kind: "drop_collection",
        field: null,
        from: collection,
        to: null,
        destructive: true,
        reviewRequired: true,
        using: null,
        detail: `collection ${collection} was removed from warehousd.yml`,
      });

  return changes;
}

export function destructive(changes: SchemaChange[]): SchemaChange[] {
  return changes.filter((c) => c.destructive);
}
