import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import { tableDDL, viewDDL, grantViewDDL, grantImportDDL, rlsDDL } from "./ddl";

export async function applyConfig(db: Pool, cfg: WarehousdConfig): Promise<void> {
  await db.query(`create extension if not exists vector`);

  // Taxonomies: upsert by slug (labels renameable in place). apply never deletes
  // vocabularies/terms — data rows store term slugs, so removal is a manual operation.
  for (const [slug, v] of Object.entries(cfg.taxonomies ?? {})) {
    const vid = (await db.query(
      `insert into app.vocabularies (slug, label) values ($1,$2)
       on conflict (slug) do update set label=excluded.label returning id`,
      [slug, v.label])).rows[0].id;
    for (const [t, tv] of Object.entries(v.terms))
      await db.query(
        `insert into app.terms (vocabulary_id, slug, label) values ($1,$2,$3)
         on conflict (vocabulary_id, slug) do update set label=excluded.label`,
        [vid, t, tv.label]);
  }

  for (const name of Object.keys(cfg.collections)) {
    for (const env of ["dev", "live"] as const) {
      await db.query(tableDDL(env, name, cfg));
    }
  }
  // views after all tables (joins reference sibling tables)
  // A stack provisioned before the import role existed still applies cleanly.
  const hasImportRole = (await db.query(
    `select 1 from pg_roles where rolname='warehousd_import'`)).rowCount === 1;

  for (const name of Object.keys(cfg.collections)) {
    for (const env of ["dev", "live"] as const) {
      await db.query(viewDDL(env, name, cfg));
      await db.query(grantViewDDL(env, name));
      await db.query(rlsDDL(env, name, cfg));
    }
    const importGrant = grantImportDDL(name, cfg);
    if (hasImportRole && importGrant) await db.query(importGrant);

    const c = cfg.collections[name];
    if (!c) throw new Error(`Unknown collection: ${name}`);
    await db.query(
      `insert into app.collections (name, description, config, updated_at)
       values ($1,$2,$3, now())
       on conflict (name) do update set description=excluded.description,
         config=excluded.config, updated_at=now()`,
      [name, c.description, JSON.stringify(c)]);
  }
}
