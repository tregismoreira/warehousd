import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import {
  tableDDL,
  viewDDL,
  grantViewDDL,
  grantImportDDL,
  rlsDDL,
  grantWriteDDL,
  DEFAULT_EMBEDDING_DIMENSIONS,
} from "./ddl";

export async function applyConfig(db: Pool, cfg: WarehousdConfig): Promise<void> {
  await db.query(`create extension if not exists vector`);
  // hmac(), for `mask: { transform: hash }`. Created unconditionally rather than only when some
  // collection declares that transform: a later `warehousd apply` adding one must not be the
  // first thing that needs a superuser, long after the deployment stopped having one.
  await db.query(`create extension if not exists pgcrypto`);

  // Vocabularies: upsert by slug (labels renameable in place). apply never deletes
  // vocabularies/terms — data rows store term slugs, so removal is a manual operation.
  for (const [slug, v] of Object.entries(cfg.taxonomies ?? {})) {
    const vid = (
      await db.query(
        `insert into app.vocabularies (slug, label) values ($1,$2)
       on conflict (slug) do update set label=excluded.label returning id`,
        [slug, v.label],
      )
    ).rows[0].id;
    // Insert YAML-sourced terms with env='all'
    if (v.terms) {
      for (const [t, tv] of Object.entries(v.terms))
        await db.query(
          `insert into app.terms (vocabulary_id, env, slug, label) values ($1,$2,$3,$4)
           on conflict (vocabulary_id, env, slug) do update set label=excluded.label`,
          [vid, "all", t, tv.label],
        );
    }
    // Dataset-sourced vocabularies: terms are synced by syncDatasetTerms, not here
  }

  for (const name of Object.keys(cfg.collections)) {
    const c = cfg.collections[name];
    if (!c) throw new Error(`Unknown collection: ${name}`);

    // A changed embedding dimension means a changed model, and pgvector cannot widen a column
    // in place. The stored vectors are derived data — re-derivable by `warehousd embed` — so the
    // column is dropped and recreated rather than the apply refusing. Detected via atttypmod,
    // which is where pgvector keeps the width.
    if (c.type === "file") {
      const want = cfg.embedding?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
      for (const env of ["dev", "live"] as const) {
        const schema = env === "dev" ? "data_synth" : "data_live";
        const cur = await db.query<{ atttypmod: number }>(
          `select a.atttypmod from pg_attribute a
             join pg_class t on t.oid = a.attrelid
             join pg_namespace n on n.oid = t.relnamespace
           where n.nspname = $1 and t.relname = $2 and a.attname = 'embedding' and a.attnum > 0`,
          [schema, `${name}__documents`],
        );
        const have = cur.rows[0]?.atttypmod;
        if (have !== undefined && have > 0 && have !== want) {
          await db.query(`alter table ${schema}."${name}__documents" drop column embedding`);
        }
      }
    }

    // Migration detection: every dataset is revisioned now, so a pre-existing table WITHOUT
    // _rev* columns cannot be brought forward by `create table if not exists` — the alters
    // below would add the data columns and leave the NOT NULL bookkeeping ones missing, and
    // the first insert would fail a long way from the cause. The _rev* columns are the marker.
    // Migrating existing rows into revisions is explicitly out of scope: fail loudly here.
    if (c.type === "dataset") {
      for (const env of ["dev", "live"] as const) {
        const schema = env === "dev" ? "data_synth" : "data_live";
        const check = await db.query(
          `select 1 from information_schema.tables where table_schema=$1 and table_name=$2`,
          [schema, name],
        );
        if (check.rowCount === 1) {
          const hasRev = await db.query(
            `select 1 from information_schema.columns where table_schema=$1 and table_name=$2 and column_name='_rev'`,
            [schema, name],
          );
          if (hasRev.rowCount === 0) {
            throw new Error(
              `Cannot apply ${name} — the table in ${schema} already exists without revision ` +
                `columns. Every dataset is revisioned; migrating existing data into revisions is ` +
                `out of scope. Drop the table manually or use a different collection name.`,
            );
          }
        }
      }
    }

    for (const env of ["dev", "live"] as const) {
      await db.query(tableDDL(env, name, cfg));
    }
  }
  // views after all tables (joins reference sibling tables)
  // A stack provisioned before the import role existed still applies cleanly.
  const hasImportRole =
    (await db.query(`select 1 from pg_roles where rolname='warehousd_import'`)).rowCount === 1;
  const hasWriteRoles =
    (await db.query(`select 1 from pg_roles where rolname='warehousd_live_write'`)).rowCount === 1;

  for (const name of Object.keys(cfg.collections)) {
    for (const env of ["dev", "live"] as const) {
      await db.query(viewDDL(env, name, cfg));
      await db.query(grantViewDDL(env, name));
      await db.query(rlsDDL(env, name, cfg));
    }
    const importGrant = grantImportDDL(name, cfg);
    if (hasImportRole && importGrant) await db.query(importGrant);

    if (hasWriteRoles) {
      for (const env of ["dev", "live"] as const) {
        const writeGrant = grantWriteDDL(env, name, cfg);
        if (writeGrant) await db.query(writeGrant);
      }
    }

    const c = cfg.collections[name];
    if (!c) throw new Error(`Unknown collection: ${name}`);
    await db.query(
      `insert into app.collections (name, description, config, updated_at)
       values ($1,$2,$3, now())
       on conflict (name) do update set description=excluded.description,
         config=excluded.config, updated_at=now()`,
      [name, c.description, JSON.stringify(c)],
    );
  }
}
