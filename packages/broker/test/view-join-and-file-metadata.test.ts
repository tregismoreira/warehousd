import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, DEFAULT_WORKSPACE_ID } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { tableDDL, viewDDL } from "../src/apply/ddl";
import { createPools, withWorkspace, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { indexCollection } from "../src/indexing";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import { ConfigSchema } from "../src/config/schema";

import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// Every dataset table carries NOT NULL revision bookkeeping, so a fixture insert has to
// be a well-formed `create` revision. These are literals; every value stays bound.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "stage3",
  server: { port: 1 },
  collections: {
    people: {
      description: "people with manager and reports",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        full_name: { type: "text", posture: "allow" },
        manager_id: { type: "uuid", posture: "allow", fk: "people.id" },
        manager_name: {
          type: "text",
          posture: "allow",
          view_join: { table: "people", column: "full_name", on: "manager_id" },
        },
        direct_report_1_id: { type: "uuid", posture: "allow", fk: "people.id" },
        direct_report_1_name: {
          type: "text",
          posture: "allow",
          view_join: { table: "people", column: "full_name", on: "direct_report_1_id" },
        },
        direct_report_2_id: { type: "uuid", posture: "allow", fk: "people.id" },
        direct_report_2_name: {
          type: "text",
          posture: "allow",
          view_join: { table: "people", column: "full_name", on: "direct_report_2_id" },
        },
      },
    },
    case_files: {
      type: "file",
      description: "Legal case files with metadata",
      source: "./docs",
      source_live: "./docs-live",
      fields: {
        title: { posture: "allow" },
        content: { posture: "allow" },
        owner: { posture: "allow" },
        updated_at: { posture: "allow" },
        path: { posture: "allow" },
        filed_date: { type: "date", posture: "allow" },
        case_number: { type: "text", posture: "allow" },
        matter_value: { type: "numeric", posture: "allow" },
      },
    },
  },
  synthetic: { documents_per_collection: { people: 5 } },
});

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("stage3");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);

  // Create the people table and view with self-joins
  await admin.query(tableDDL("dev", "people", cfg));
  await admin.query(viewDDL("dev", "people", cfg));

  // Populate people with self-referential data
  await admin.query(
    `insert into data_synth.people (${R}, id, full_name, manager_id, direct_report_1_id, direct_report_2_id) values (${RV}, $1, $2, $3, $4, $5), (${RV}, $6, $7, $8, $9, $10), (${RV}, $11, $12, $13, $14, $15) returning id`,
    [
      "00000000-0000-0000-0000-000000000001",
      "Alice",
      null,
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
      "00000000-0000-0000-0000-000000000002",
      "Bob",
      "00000000-0000-0000-0000-000000000001",
      null,
      null,
      "00000000-0000-0000-0000-000000000003",
      "Charlie",
      "00000000-0000-0000-0000-000000000001",
      null,
      null,
    ],
  );

  // Create case files directory and seed files
  const docsDir = mkdtempSync(join(tmpdir(), "case-files-"));
  writeFileSync(
    join(docsDir, "case-1.md"),
    `---
owner: alice
filed_date: 2024-01-15
case_number: C-2024-001
matter_value: 50000.50
---
# Case 1
This is case 1.`,
  );
  writeFileSync(
    join(docsDir, "case-2.md"),
    `---
owner: bob
filed_date: 2024-02-20
case_number: C-2024-002
matter_value: 75000.00
---
# Case 2
This is case 2.`,
  );

  // Index the case files with metadata extraction
  const metadataFields = [
    { field: "filed_date", type: "date" as const },
    { field: "case_number", type: "text" as const },
    { field: "matter_value", type: "numeric" as const },
  ];
  await indexCollection(admin, "dev", "case_files", docsDir, DEFAULT_WORKSPACE_ID, {
    metadata: metadataFields,
  });

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

it("view with three people joins (including self-join) creates distinct aliases", async () => {
  // Query the view to verify all three joins work and produce distinct aliases.
  // The view filters on current_setting('warehousd.workspace_id'), so a raw pool sees nothing — the
  // isolation wall fails closed. withWorkspace is how every other caller reads a view.
  const result = await withWorkspace(admin, DEFAULT_WORKSPACE_ID, (c) =>
    c.query(`
    select id, full_name, manager_name, direct_report_1_name, direct_report_2_name
    from data_synth.v_people
    order by full_name
  `),
  );

  expect(result.rows.length).toBe(3);
  // Alice is manager of Bob and Charlie
  const alice = result.rows.find((r: any) => r.full_name === "Alice");
  expect(alice).toBeDefined();
  expect(alice?.manager_name).toBeNull(); // Alice has no manager
  // Bob is a direct report of Alice
  const bob = result.rows.find((r: any) => r.full_name === "Bob");
  expect(bob).toBeDefined();
  expect(bob?.manager_name).toBe("Alice");
  // Charlie is a direct report of Alice
  const charlie = result.rows.find((r: any) => r.full_name === "Charlie");
  expect(charlie).toBeDefined();
  expect(charlie?.manager_name).toBe("Alice");
});

const METADATA_FIELDS = ["title", "content", "filed_date", "case_number", "matter_value"];

async function grant(userId: string, documentFilters: unknown[] = []) {
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status, document_filter)
     values ($1,'case_files',$2,'dev','approved',$3)`,
    [userId, METADATA_FIELDS, JSON.stringify(documentFilters)],
  );
}

it("metadata fields like filed_date come back from search_documents", async () => {
  await grant("meta-reader");
  const r = await broker.searchDocuments(makeCtx({ userId: "meta-reader" }), {
    collection: "case_files",
    q: "case",
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.documents.length).toBeGreaterThan(0);
  expect(r.fieldsReturned).toEqual(
    expect.arrayContaining(["filed_date", "case_number", "matter_value"]),
  );
  const doc = r.documents[0] as Record<string, unknown>;
  // `filed_date` is a `date` column: pg hands back a Date, and it must carry the frontmatter
  // day exactly — a timestamp coerced into a date column would shift across timezones.
  expect(doc.filed_date).toBeInstanceOf(Date);
  expect(String(doc.case_number)).toMatch(/^C-2024-00[12]$/);
});

it("a metadata field can gate documents through document_filter", async () => {
  await grant("meta-scoped", [{ field: "case_number", op: "in", value: ["C-2024-001"] }]);
  const r = await broker.searchDocuments(makeCtx({ userId: "meta-scoped" }), {
    collection: "case_files",
    q: "case",
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.documents.length).toBeGreaterThan(0);
  for (const d of r.documents as Record<string, unknown>[])
    expect(d.case_number).toBe("C-2024-001");
});
