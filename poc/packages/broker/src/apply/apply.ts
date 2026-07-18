import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import { tableDDL, viewDDL, grantViewDDL } from "./ddl";

export async function applyConfig(db: Pool, cfg: WarehousdConfig): Promise<void> {
  for (const name of Object.keys(cfg.collections)) {
    for (const env of ["dev", "live"] as const) {
      await db.query(tableDDL(env, name, cfg));
    }
  }
  // views after all tables (joins reference sibling tables)
  for (const name of Object.keys(cfg.collections)) {
    for (const env of ["dev", "live"] as const) {
      await db.query(viewDDL(env, name, cfg));
      await db.query(grantViewDDL(env, name));
    }
    await db.query(
      `insert into app.collections (name, description, config, updated_at)
       values ($1,$2,$3, now())
       on conflict (name) do update set description=excluded.description,
         config=excluded.config, updated_at=now()`,
      [name, cfg.collections[name].description, JSON.stringify(cfg.collections[name])]);
  }
}
