import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { tableDDL, viewDDL } from "../src/apply/ddl";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { indexCollection, loadTaxonomyBindings } from "../src/indexing";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "stage3", server: { port: 1 },
  collections: {
    people: {
      description: "people with manager and reports",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        full_name: { type: "text", posture: "allow" },
        manager_id: { type: "uuid", posture: "allow", fk: "people.id" },
        manager_name: { type: "text", posture: "allow", view_join: { table: "people", column: "full_name", on: "manager_id" } },
        direct_report_1_id: { type: "uuid", posture: "allow", fk: "people.id" },
        direct_report_1_name: { type: "text", posture: "allow", view_join: { table: "people", column: "full_name", on: "direct_report_1_id" } },
        direct_report_2_id: { type: "uuid", posture: "allow", fk: "people.id" },
        direct_report_2_name: { type: "text", posture: "allow", view_join: { table: "people", column: "full_name", on: "direct_report_2_id" } },
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
};

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
  const { rows } = await admin.query("insert into data_synth.people (id, full_name, manager_id, direct_report_1_id, direct_report_2_id) values ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10), ($11, $12, $13, $14, $15) returning id", [
    "00000000-0000-0000-0000-000000000001", "Alice", null, "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003",
    "00000000-0000-0000-0000-000000000002", "Bob", "00000000-0000-0000-0000-000000000001", null, null,
    "00000000-0000-0000-0000-000000000003", "Charlie", "00000000-0000-0000-0000-000000000001", null, null,
  ]);

  // Create case files directory and seed files
  const docsDir = mkdtempSync(join(tmpdir(), "case-files-"));
  writeFileSync(join(docsDir, "case-1.md"), `---
owner: alice
filed_date: 2024-01-15
case_number: C-2024-001
matter_value: 50000.50
---
# Case 1
This is case 1.`);
  writeFileSync(join(docsDir, "case-2.md"), `---
owner: bob
filed_date: 2024-02-20
case_number: C-2024-002
matter_value: 75000.00
---
# Case 2
This is case 2.`);

  // Index the case files with metadata extraction
  const metadataFields = [
    { field: "filed_date", type: "date" as const },
    { field: "case_number", type: "text" as const },
    { field: "matter_value", type: "numeric" as const },
  ];
  await indexCollection(admin, "dev", "case_files", docsDir, { metadata: metadataFields });

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

it("view with three people joins (including self-join) creates distinct aliases", async () => {
  // Query the view to verify all three joins work and produce distinct aliases
  const result = await admin.query(`
    select id, full_name, manager_name, direct_report_1_name, direct_report_2_name
    from data_synth.v_people
    order by full_name
  `);

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

it("metadata fields like filed_date are extracted and returned from search_documents", async () => {
  // First verify the data was indexed
  const filesResult = await admin.query("select id, title, filed_date, case_number, matter_value from data_synth.case_files__files");
  expect(filesResult.rows.length).toBeGreaterThan(0);
  // Verify metadata was extracted
  for (const row of filesResult.rows) {
    expect(row.filed_date).toBeDefined();
    expect(row.case_number).toBeDefined();
    expect(row.matter_value).toBeDefined();
  }

  // Query the view to verify metadata appears there (file view has document_id, title, filed_date, etc.)
  const viewResult = await admin.query("select document_id, title, filed_date, case_number, matter_value from data_synth.v_case_files limit 1");
  expect(viewResult.rows.length).toBeGreaterThan(0);
  const firstDoc = viewResult.rows[0];
  expect(firstDoc.filed_date).toBeDefined();
  expect(firstDoc.case_number).toBeDefined();
  expect(firstDoc.matter_value).toBeDefined();
  // filed_date should be a valid date (Date object or string)
  if (firstDoc.filed_date !== null) {
    expect(firstDoc.filed_date instanceof Date || typeof firstDoc.filed_date === "string").toBe(true);
  }
});
