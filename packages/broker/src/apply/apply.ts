import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import { tableDDL, viewDDL, grantViewDDL, grantImportDDL, rlsDDL, grantWriteDDL } from "./ddl";

export async function applyConfig(db: Pool, cfg: WarehousdConfig): Promise<void> {
  await db.query(`create extension if not exists vector`);

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
