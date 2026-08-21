import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { ConfigSchema } from "../src/config/schema";
import { applyConfig, planFromSchema, renderMigrationSql, migrateApp } from "../src/index";

function config(indexes: unknown[]) {
  return ConfigSchema.parse({
    project: "t",
    collections: {
      matters: {
        description: "Matters",
        indexes,
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          status: { type: "text", posture: "allow" },
        },
      },
    },
  });
}

describe("index planning", () => {
  let p: Provisioned;
  let db: Pool;

  beforeAll(async () => {
    p = await provision("index-plan");
    db = new Pool({ connectionString: p.urls.admin, max: 2 });
    await migrateApp(db);
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await p.end();
  });

  it("reports add_index for a declared index that does not exist yet", async () => {
    await applyConfig(db, config([]));
    const changes = await planFromSchema(db, config([{ fields: ["status"] }]));
    const adds = changes.filter((c) => c.kind === "add_index");
    expect(adds.map((c) => `${c.env}:${c.to}`).sort()).toEqual([
      "dev:matters_ix_status",
      "live:matters_ix_status",
    ]);
    expect(adds.every((c) => c.destructive === false && c.reviewRequired === false)).toBe(true);
  });

  it("reports no change once applyConfig has created it", async () => {
    await applyConfig(db, config([{ fields: ["status"] }]));
    const changes = await planFromSchema(db, config([{ fields: ["status"] }]));
    expect(changes.filter((c) => c.kind === "add_index" || c.kind === "drop_index")).toEqual([]);
  });

  it("reports drop_index when the index leaves the config, and applyConfig does not drop it", async () => {
    await applyConfig(db, config([{ fields: ["status"] }]));
    // The config no longer declares it. apply is additive, so the index must survive.
    await applyConfig(db, config([]));
    const still = await db.query(
      `select 1 from pg_indexes where schemaname='data_live' and indexname='matters_ix_status'`,
    );
    expect(still.rowCount).toBe(1);

    const changes = await planFromSchema(db, config([]));
    const drops = changes.filter((c) => c.kind === "drop_index");
    expect(drops.map((c) => `${c.env}:${c.from}`).sort()).toEqual([
      "dev:matters_ix_status",
      "live:matters_ix_status",
    ]);
    expect(drops.every((c) => c.destructive === false && c.reviewRequired === true)).toBe(true);
  });

  it("never proposes dropping an index the broker did not declare", async () => {
    await db.query(`create index if not exists matters_operator_idx on data_live.matters (status)`);
    const changes = await planFromSchema(db, config([]));
    expect(changes.some((c) => c.from === "matters_operator_idx")).toBe(false);
  });

  it("never proposes dropping the structural history index", async () => {
    const changes = await planFromSchema(db, config([]));
    expect(changes.some((c) => c.from === "matters_history_idx")).toBe(false);
  });

  it("renders a commented drop for the live environment only", async () => {
    const changes = await planFromSchema(db, config([]));
    const sql = renderMigrationSql(changes);
    expect(sql).toContain(`-- drop index concurrently if exists data_live."matters_ix_status";`);
    // Not `data_synth` outright — the file's fixed HEADER mentions it in prose — but no
    // statement targets a data_synth schema-qualified name.
    expect(sql).not.toContain("data_synth.");
  });

  it("renders no view drop when the only change is a dropped index", async () => {
    const changes = (await planFromSchema(db, config([]))).filter((c) => c.kind === "drop_index");
    expect(renderMigrationSql(changes)).not.toContain("drop view");
  });
});
