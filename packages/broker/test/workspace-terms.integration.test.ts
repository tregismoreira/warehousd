import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { ConfigSchema } from "../src/config/schema";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { syncDatasetTerms, loadTaxonomyBindings } from "../src/taxonomy";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// A dataset-sourced vocabulary's terms are materialised FROM tenant rows (syncDatasetTerms
// selects distinct values out of a collection). Without a workspace_id on app.terms, workspace
// B's grant-authoring term picker and describeCollection listed workspace A's client numbers
// and names outright — see migration 0010 and taxonomy.ts. This is the canary per AGENTS.md
// non-negotiable 5: it must fail if that scoping regresses.
const CANARY = "ZZQX-CANARY-CLIENT";
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

const WS_A = "wstermsA";
const WS_B = "wstermsB";

const cfg = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  taxonomies: {
    // Dataset-sourced: terms are ROWS, derived per workspace by syncDatasetTerms — the leak.
    client: {
      label: "Client",
      source: { collection: "clients", slug: "client_number", label: "name" },
    },
    // Config-declared: workspace_id='*' at apply time — deployment-global by design, visible
    // from every workspace regardless of whose data derived the dataset-sourced terms above.
    department: {
      label: "Department",
      terms: {
        eng: { label: "Engineering" },
        sales: { label: "Sales" },
      },
    },
  },
  collections: {
    clients: {
      description: "clients",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        client_number: { type: "text", posture: "allow" },
        name: { type: "text", posture: "allow" },
      },
    },
    cases: {
      description: "cases",
      taxonomies: ["client", "department"],
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: "allow" },
      },
    },
  },
});

let p: Provisioned, admin: Pool;

beforeAll(async () => {
  p = await provision("wsterms");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await admin.query(
    `insert into app.workspaces (id, name) values ($1, 'A'), ($2, 'B') on conflict do nothing`,
    [WS_A, WS_B],
  );
  await applyConfig(admin, cfg);

  // Workspace A's clients carry the canary; workspace B's are unrelated rows.
  await admin.query(
    `insert into data_synth.clients (${R}, workspace_id, id, client_number, name) values
      (${RV}, $1, gen_random_uuid(), 'A-0001', $2)`,
    [WS_A, CANARY],
  );
  await admin.query(
    `insert into data_synth.clients (${R}, workspace_id, id, client_number, name) values
      (${RV}, $1, gen_random_uuid(), 'B-0001', 'Beacon Manufacturing')`,
    [WS_B],
  );

  await syncDatasetTerms(admin, cfg, "dev", WS_A);
  await syncDatasetTerms(admin, cfg, "dev", WS_B);
}, 60_000);

afterAll(async () => {
  await admin?.end();
  await p?.end();
});

describe("dataset-sourced terms never cross a workspace boundary", () => {
  it("the canary appears in A's bindings", async () => {
    const bindings = await loadTaxonomyBindings(admin, cfg, "cases", "dev", WS_A);
    const client = bindings.find((b) => b.field === "client");
    expect(client?.terms.map((t) => t.label)).toContain(CANARY);
  });

  it("the canary appears zero times in the serialized JSON of B's bindings", async () => {
    const bindings = await loadTaxonomyBindings(admin, cfg, "cases", "dev", WS_B);
    const json = JSON.stringify(bindings);
    expect(json).not.toContain(CANARY);
    // Positive control: B's own client IS present, proving the absence above is workspace
    // scoping and not an empty/broken result.
    expect(json).toContain("Beacon Manufacturing");
  });

  it("the canary appears zero times in a raw admin/taxonomies-style query scoped to B", async () => {
    // Mirrors apps/web/app/api/admin/taxonomies/route.ts's own query exactly — the other real
    // reader of app.terms — rather than re-testing loadTaxonomyBindings under a different name.
    const vid = (await admin.query(`select id from app.vocabularies where slug='client'`)).rows[0]
      .id;
    const rows = (
      await admin.query(
        `select slug, label from app.terms where vocabulary_id=$1 and env=$2 and workspace_id in ('*', $3) order by slug`,
        [vid, "dev", WS_B],
      )
    ).rows;
    expect(JSON.stringify(rows)).not.toContain(CANARY);
  });
});

describe("config-declared terms stay visible from every workspace", () => {
  it("department's terms are identical in both A and B", async () => {
    const [a] = [
      (await loadTaxonomyBindings(admin, cfg, "cases", "dev", WS_A)).find(
        (b) => b.field === "department",
      ),
    ];
    const [b] = [
      (await loadTaxonomyBindings(admin, cfg, "cases", "dev", WS_B)).find(
        (b) => b.field === "department",
      ),
    ];
    expect(a?.slugs).toEqual(["eng", "sales"]);
    expect(b?.slugs).toEqual(["eng", "sales"]);
  });
});
