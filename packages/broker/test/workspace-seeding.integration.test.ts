import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { withWorkspace } from "../src/db/pools";
import { generateSynthetic } from "../src/synthetic/generate";
import { regenerateSynthetic } from "../src/synthetic/regenerate";
import { indexCollection } from "../src/indexing";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// generateSynthetic used to insert with no workspace_id column at all, landing every row in
// 'default' via the base table's own default regardless of which workspace asked for it — see
// migration and taxonomy.ts's PR 3 sibling bug. regenerateSynthetic's `truncate … cascade` was
// worse: a cross-tenant statement that wiped every workspace's rows, not just the caller's. These
// are the canaries per AGENTS.md non-negotiable 5.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

const WS_A = "wsseedA";
const WS_B = "wsseedB";

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  synthetic: { documents_per_collection: { clients: 5 } },
  collections: {
    clients: {
      description: "Clients",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        name: { type: "text", posture: "allow" },
      },
    },
    // writable: true is the only thing that gets warehousd_dev_write an INSERT grant on this
    // table (apply/ddl.ts grantWriteDDL) — the raw-insert RLS check below needs a role that can
    // reach the base table at all, or it would fail on "permission denied" rather than on RLS.
    notes: {
      description: "Notes",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        body: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
    policies: {
      type: "file",
      description: "Policies",
      source: "./x",
      fields: {
        title: { posture: "allow" },
        content: { posture: "allow" },
        path: { posture: "deny" },
      },
    },
  },
});

let p: Provisioned, admin: Pool;

beforeAll(async () => {
  p = await provision("wsseeding");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await admin.query(
    `insert into app.workspaces (id, name) values ($1, 'A'), ($2, 'B') on conflict do nothing`,
    [WS_A, WS_B],
  );
  await applyConfig(admin, cfg);
}, 60_000);

afterAll(async () => {
  await admin?.end();
  await p?.end();
});

const countIn = async (table: string, workspaceId: string) =>
  Number(
    (
      await admin.query(
        `select count(*)::int as n from data_synth.${table} where workspace_id=$1`,
        [workspaceId],
      )
    ).rows[0].n,
  );

describe("generateSynthetic: two workspaces, same seed", () => {
  it("each workspace gets its own row count, never the sum", async () => {
    await generateSynthetic(admin, cfg, 1, WS_A);
    await generateSynthetic(admin, cfg, 1, WS_B);
    expect(await countIn("clients", WS_A)).toBe(5);
    expect(await countIn("clients", WS_B)).toBe(5);
    const total = await admin.query(`select count(*)::int as n from data_synth.clients`);
    expect(total.rows[0].n).toBe(10);
  });

  it("A's rows are unreachable from a B-scoped read, even though the shared seed collided their ids", async () => {
    const aIds = (
      await admin.query(`select id from data_synth.clients where workspace_id=$1 order by id`, [
        WS_A,
      ])
    ).rows.map((r) => r.id);
    const bIds = (
      await admin.query(`select id from data_synth.clients where workspace_id=$1 order by id`, [
        WS_B,
      ])
    ).rows.map((r) => r.id);
    // Same seed, so the id sets are byte-identical — the assertion below has to be about
    // workspace_id doing the separating, not about the ids happening to differ.
    expect(aIds).toEqual(bIds);
    const bScoped = await withWorkspace(admin, WS_B, (c) =>
      c.query(`select id from data_synth.v_clients order by id`),
    );
    expect(bScoped.rows.map((r) => r.id)).toEqual(bIds);
  });
});

describe("regenerateSynthetic: the regression this PR exists for", () => {
  it("regenerating A leaves B's row count exactly unchanged", async () => {
    const before = await countIn("clients", WS_B);
    await regenerateSynthetic(admin, cfg, WS_A, 2);
    expect(await countIn("clients", WS_B)).toBe(before);
    expect(await countIn("clients", WS_A)).toBe(5);
  });
});

describe("ingestFile / indexCollection land files in the named workspace", () => {
  it("a B-scoped read of A's file id returns 0 rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-wsseed-"));
    writeFileSync(join(dir, "a.md"), "# A\n\nAlpha body.");
    try {
      await indexCollection(admin, "dev", "policies", dir, WS_A);
    } finally {
      rmSync(dir, { recursive: true });
    }

    const fileRow = (
      await admin.query(`select id from data_synth."policies__files" where workspace_id=$1`, [WS_A])
    ).rows[0];
    expect(fileRow).toBeDefined();

    const bScoped = await admin.query(
      `select 1 from data_synth."policies__files" where id=$1 and workspace_id=$2`,
      [fileRow.id, WS_B],
    );
    expect(bScoped.rowCount).toBe(0);
  });

  // The files table's unique constraint used to be on `path` alone, so a second workspace
  // indexing a file at a path the first workspace already used hit a database-level conflict —
  // even though ingestFile's own existence check (indexing/ingest.ts) is workspace-scoped and
  // expected the insert to succeed. Two tenants uploading a file with the same name is ordinary,
  // not a collision.
  it("two workspaces can each index a file at the identical path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-wsseed-"));
    writeFileSync(join(dir, "same-name.md"), "shared filename, different tenants");
    try {
      await indexCollection(admin, "dev", "policies", dir, WS_A);
      await expect(indexCollection(admin, "dev", "policies", dir, WS_B)).resolves.not.toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }

    const rows = await admin.query(
      `select workspace_id from data_synth."policies__files" where path='same-name.md' order by workspace_id`,
    );
    expect(rows.rows.map((r) => r.workspace_id)).toEqual([WS_A, WS_B]);
  });
});

describe("a raw insert with no workspace_id, GUC unset, is rejected by RLS", () => {
  it("with check refuses rather than silently defaulting", async () => {
    // No withWorkspace: no transaction, no set_config — current_setting('warehousd.workspace_id')
    // is genuinely unset, exactly the case the with-check policy exists to refuse.
    const write = new Pool({ connectionString: p.urls.devWrite });
    try {
      await expect(
        write.query(
          `insert into data_synth.notes (${R}, id, body) values (${RV}, gen_random_uuid(), 'x')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await write.end();
    }
  });
});
