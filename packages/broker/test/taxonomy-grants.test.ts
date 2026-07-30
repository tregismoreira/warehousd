import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { provision, type Provisioned } from "./helpers/db";
import { ConfigSchema } from "../src/config/schema";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { indexCollection } from "../src/indexing";
import { syncDatasetTerms, loadTaxonomyBindings } from "../src/taxonomy";
import { makeBroker } from "../src/broker";
import { createPools, type Pools } from "../src/db/pools";
import { makeCtx } from "./helpers/ctx";

let p: Provisioned;
let admin: Pool;
let pools: Pools;
let broker: ReturnType<typeof makeBroker>;

const cfg = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  taxonomies: {
    category: {
      label: "Category",
      terms: {
        hr: { label: "HR" },
        finance: { label: "Finance" },
      },
    },
  },
  collections: {
    notes: {
      description: "notes",
      taxonomies: ["category"],
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        body: { type: "text", posture: "allow" },
      },
    },
    briefs: {
      description: "briefs",
      type: "file",
      source: "./unused",
      taxonomies: ["category"],
      fields: {
        title: { posture: "allow" },
        content: { posture: "allow" },
        path: { posture: "deny" },
        category: { posture: "allow" },
      },
    },
  },
});

beforeAll(async () => {
  p = await provision("taxgrants");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  // structured rows: 2 hr, 1 finance
  await admin.query(`insert into data_synth.notes (id, body, category) values
    (gen_random_uuid(), 'hr note one', 'hr'),
    (gen_random_uuid(), 'hr note two', 'hr'),
    (gen_random_uuid(), 'finance note', 'finance')`);
  // documents: one per term
  const dir = mkdtempSync(join(tmpdir(), "taxdocs-"));
  writeFileSync(
    join(dir, "handbook.md"),
    "---\ncategory: hr\n---\n# Handbook\n\nVacation policy paragraph.",
  );
  writeFileSync(
    join(dir, "budget.md"),
    "---\ncategory: finance\n---\n# Budget\n\nVacation budget paragraph.",
  );
  await syncDatasetTerms(admin, cfg, "dev");
  await indexCollection(admin, "dev", "briefs", dir, {
    taxonomies: await loadTaxonomyBindings(admin, cfg, "briefs", "dev"),
  });
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

async function grant(
  user: string,
  collection: string,
  fields: string[],
  documentFilters: object[] | null,
) {
  await admin.query(`delete from app.grants where user_id=$1 and collection=$2`, [
    user,
    collection,
  ]);
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status, document_filter)
     values ($1,$2,$3,'dev','approved',$4)`,
    [user, collection, fields, documentFilters ? JSON.stringify(documentFilters) : null],
  );
}

describe("term-scoped grants: structured", () => {
  it("document_filter on the term restricts documents; excluded documents silently absent", async () => {
    await grant(
      "u1",
      "notes",
      ["id", "body", "category"],
      [{ field: "category", op: "in", value: ["hr"] }],
    );
    const r = await broker.query(makeCtx({ userId: "u1" }), { collection: "notes" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documents.length).toBe(2);
      for (const row of r.documents) expect(row.category).toBe("hr");
    }
  });

  it("client filters AND with the term scope — no widening", async () => {
    await grant(
      "u1",
      "notes",
      ["id", "body", "category"],
      [{ field: "category", op: "in", value: ["hr"] }],
    );
    const r = await broker.query(makeCtx({ userId: "u1" }), {
      collection: "notes",
      filters: [{ field: "category", op: "eq", value: "finance" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.length).toBe(0);
  });

  it("term field can gate rows without being readable (deny-style)", async () => {
    await grant("u2", "notes", ["id", "body"], [{ field: "category", op: "in", value: ["hr"] }]);
    const r = await broker.query(makeCtx({ userId: "u2" }), { collection: "notes" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documents.length).toBe(2);
      for (const row of r.documents) expect("category" in row).toBe(false); // absent, not null
    }
    const denied = await broker.query(makeCtx({ userId: "u2" }), {
      collection: "notes",
      fields: ["category"],
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("field_denied");
  });

  it("empty in-list denies all rows", async () => {
    await grant("u3", "notes", ["id", "body"], [{ field: "category", op: "in", value: [] }]);
    const r = await broker.query(makeCtx({ userId: "u3" }), { collection: "notes" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.length).toBe(0);
  });
});

describe("term-scoped grants: file search", () => {
  it("searchDocuments only reaches documents inside the term scope", async () => {
    await grant(
      "u4",
      "briefs",
      ["title", "content", "category"],
      [{ field: "category", op: "in", value: ["hr"] }],
    );
    // "vacation" matches a document in BOTH files — only the hr one may return
    const r = await broker.searchDocuments(makeCtx({ userId: "u4" }), {
      collection: "briefs",
      q: "vacation",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documents.length).toBeGreaterThan(0);
      for (const row of r.documents) {
        expect(row.category).toBe("hr");
        expect(row.title).toBe("Handbook");
      }
    }
  });

  it("broker.query on the bound file collection filters by term too", async () => {
    await grant(
      "u4",
      "briefs",
      ["title", "content", "category"],
      [{ field: "category", op: "in", value: ["hr"] }],
    );
    const r = await broker.query(makeCtx({ userId: "u4" }), { collection: "briefs" });
    expect(r.ok).toBe(true);
    if (r.ok) for (const row of r.documents) expect(row.category).toBe("hr");
  });
});

describe("audit", () => {
  it("term-scoped calls are audited like any other", async () => {
    const n = (
      await admin.query(
        `select count(*)::int as n from app.audit_events where user_id in ('u1','u2','u3','u4')`,
      )
    ).rows[0].n;
    expect(n).toBeGreaterThan(0);
  });
});

describe("Stage 2: multi-predicate document filters", () => {
  let p2: Provisioned, admin2: Pool, pools2: Pools, broker2: ReturnType<typeof makeBroker>;

  beforeAll(async () => {
    // Setup: collection bound to TWO vocabularies
    const cfg2 = ConfigSchema.parse({
      project: "t",
      server: { port: 1 },
      taxonomies: {
        priority: { label: "Priority", terms: { high: { label: "High" }, low: { label: "Low" } } },
        severity: {
          label: "Severity",
          terms: { critical: { label: "Critical" }, minor: { label: "Minor" } },
        },
      },
      collections: {
        incidents: {
          description: "incidents",
          taxonomies: ["priority", "severity"],
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            title: { type: "text", posture: "allow" },
            priority: { posture: "allow" },
            severity: { posture: "allow" },
          },
        },
      },
    });

    p2 = await provision("multi-vocab");
    admin2 = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(admin2);
    await applyConfig(admin2, cfg2);

    // Insert test data: 4 combinations
    await admin2.query(`insert into data_synth.incidents (id, title, priority, severity) values
      (gen_random_uuid(), 'high-critical', 'high', 'critical'),
      (gen_random_uuid(), 'high-minor', 'high', 'minor'),
      (gen_random_uuid(), 'low-critical', 'low', 'critical'),
      (gen_random_uuid(), 'low-minor', 'low', 'minor')`);

    pools2 = createPools({ app: p2.urls.admin, dev: p2.urls.dev, live: p2.urls.live });
    broker2 = makeBroker(pools2, cfg2);
  });

  afterAll(async () => {
    await admin2.end();
    await pools2.end();
    await p2.end();
  });

  it("multiple predicates AND together: high priority AND critical severity", async () => {
    // Grant with two predicates: priority=high AND severity=critical
    await admin2.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter)
      values ('u_multi','incidents',array['id','title','priority','severity'],'dev','approved',
       '[{"field":"priority","op":"in","value":["high"]},{"field":"severity","op":"in","value":["critical"]}]'::jsonb)`);

    const r = await broker2.query(makeCtx({ userId: "u_multi" }), { collection: "incidents" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Should only return the high-critical incident
      expect(r.documents).toHaveLength(1);
      expect(r.documents[0]!.title).toBe("high-critical");
    }
  });
});

// A `multiple: true` vocabulary is a text[] column, so every predicate against it must come
// out as `&&`/`= any`. These run through the broker rather than buildSelect directly: the
// scalar-vs-array decision is the broker's to make, and a stubbed isMultiValueField in a
// buildSelect unit test proves only that the branch exists, not that anything reaches it.
describe("multi-value term scoping through the broker", () => {
  let p3: Provisioned, admin3: Pool, pools3: Pools, broker3: ReturnType<typeof makeBroker>;

  const cfg3 = ConfigSchema.parse({
    project: "t",
    server: { port: 1 },
    taxonomies: {
      tags: {
        label: "Tags",
        multiple: true,
        terms: {
          litigation: { label: "Litigation" },
          discovery: { label: "Discovery" },
          filings: { label: "Filings" },
          tax: { label: "Tax" },
        },
      },
      client: {
        label: "Client",
        terms: { "c-0042": { label: "Acme" }, "c-0099": { label: "Globex" } },
      },
    },
    collections: {
      case_files: {
        description: "case files",
        type: "file",
        source: "./unused",
        taxonomies: ["client", "tags"],
        fields: {
          title: { posture: "allow" },
          content: { posture: "allow" },
          path: { posture: "deny" },
          client: { posture: "allow" },
          tags: { posture: "allow" },
        },
      },
    },
  });

  beforeAll(async () => {
    p3 = await provision("multivalue");
    admin3 = new Pool({ connectionString: p3.urls.admin });
    await createAppSchema(admin3);
    await applyConfig(admin3, cfg3);

    const dir = mkdtempSync(join(tmpdir(), "multivalue-"));
    // Two documents for the same client, differing only in tags, so a wrong operator can't
    // pass by accident: one overlaps the granted tag set, one does not.
    writeFileSync(
      join(dir, "motion.md"),
      "---\nclient: c-0042\ntags: [litigation, discovery]\n---\n# Motion\n\nVacation paragraph.",
    );
    writeFileSync(
      join(dir, "tax-memo.md"),
      "---\nclient: c-0042\ntags: [tax]\n---\n# Tax Memo\n\nVacation paragraph.",
    );
    // Same tags as motion.md but a different client — proves the two predicates AND, and
    // that the array predicate alone is not doing all the work.
    writeFileSync(
      join(dir, "other-client.md"),
      "---\nclient: c-0099\ntags: [litigation, discovery]\n---\n# Other\n\nVacation paragraph.",
    );
    await syncDatasetTerms(admin3, cfg3, "dev");
    await indexCollection(admin3, "dev", "case_files", dir, {
      taxonomies: await loadTaxonomyBindings(admin3, cfg3, "case_files", "dev"),
    });

    pools3 = createPools({ app: p3.urls.admin, dev: p3.urls.dev, live: p3.urls.live });
    broker3 = makeBroker(pools3, cfg3);
  });

  afterAll(async () => {
    await admin3.end();
    await pools3.end();
    await p3.end();
  });

  it("stores a multi-value term column as text[]", async () => {
    const t = (
      await admin3.query(
        `select data_type from information_schema.columns
       where table_schema='data_synth' and table_name='case_files__files' and column_name='tags'`,
      )
    ).rows[0];
    expect(t.data_type).toBe("ARRAY");
  });

  it("describe_collection reports the multi-value term field as text[], not text", async () => {
    await admin3.query(`insert into app.grants (user_id,collection,allowed_fields,env,status)
      values ('u_desc','case_files',array['title','client','tags'],'dev','approved')`);
    const d = await broker3.describeCollection(makeCtx({ userId: "u_desc" }), "case_files");
    expect("ok" in d && d.ok === false).toBe(false);
    if (!("ok" in d)) {
      const byName = Object.fromEntries(d.fields.map((f) => [f.name, f.type]));
      // The config pins both to `text`; only `tags` is actually an array column.
      expect(byName.tags).toBe("text[]");
      expect(byName.client).toBe("text");
    }
  });

  it("an `in` predicate on a multi-value field overlaps rather than compares", async () => {
    await admin3.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter)
      values ('u_mv','case_files',array['title','content','client','tags'],'dev','approved',
       '[{"field":"tags","op":"in","value":["litigation","filings"]}]'::jsonb)`);

    const r = await broker3.query(makeCtx({ userId: "u_mv" }), { collection: "case_files" });
    // Before isMultiValueField reached buildSelect this refused with internal_error, because
    // `"tags" in ($1,$2)` asks Postgres to compare text[] against text.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documents.map((d) => d.title).sort()).toEqual(["Motion", "Other"]);
    }
  });

  it("ANDs a single-value client predicate with a multi-value tag overlap", async () => {
    await admin3.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter)
      values ('u_mv2','case_files',array['title','content','client','tags'],'dev','approved',
       '[{"field":"client","op":"in","value":["c-0042"]},
         {"field":"tags","op":"in","value":["litigation","discovery","filings"]}]'::jsonb)`);

    const r = await broker3.query(makeCtx({ userId: "u_mv2" }), { collection: "case_files" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // tax-memo.md fails the tag overlap, other-client.md fails the client predicate.
      expect(r.documents).toHaveLength(1);
      expect(r.documents[0]!.title).toBe("Motion");
    }
  });

  it("searchDocuments honours the same overlap scope", async () => {
    const r = await broker3.searchDocuments(makeCtx({ userId: "u_mv2" }), {
      collection: "case_files",
      q: "vacation",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documents.length).toBeGreaterThan(0);
      for (const row of r.documents) expect(row.title).toBe("Motion");
    }
  });

  it("a client filter naming a multi-value field ANDs with the grant's overlap, never widens it", async () => {
    const r = await broker3.query(makeCtx({ userId: "u_mv2" }), {
      collection: "case_files",
      filters: [{ field: "tags", op: "in", value: ["tax"] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents).toHaveLength(0);
  });

  it("an empty in-list on a multi-value field matches nothing rather than erroring", async () => {
    const r = await broker3.query(makeCtx({ userId: "u_mv2" }), {
      collection: "case_files",
      filters: [{ field: "tags", op: "in", value: [] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents).toHaveLength(0);
  });

  it("refuses an ordering operator on a multi-value field as invalid_intent, not internal_error", async () => {
    // `"tags" > $1` would compare text[] to text; the caller needs to know it's their filter.
    const r = await broker3.query(makeCtx({ userId: "u_mv2" }), {
      collection: "case_files",
      filters: [{ field: "tags", op: "gt", value: "litigation" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_intent");
  });
});

// A dataset-sourced vocabulary's terms come from rows, not YAML, and are scoped per env. The
// labels only exist in app.terms, so this is also what stands between the manager's term picker
// and a list of bare `c-0042` slugs.
describe("dataset-sourced vocabulary terms", () => {
  let p4: Provisioned, admin4: Pool;

  const cfg4 = ConfigSchema.parse({
    project: "t",
    server: { port: 1 },
    taxonomies: {
      client: {
        label: "Client",
        source: { collection: "clients", slug: "client_number", label: "name" },
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
        type: "file",
        source: "./unused",
        taxonomies: ["client"],
        fields: {
          title: { posture: "allow" },
          content: { posture: "allow" },
          path: { posture: "deny" },
        },
      },
    },
  });

  beforeAll(async () => {
    p4 = await provision("datasetterms");
    admin4 = new Pool({ connectionString: p4.urls.admin });
    await createAppSchema(admin4);
    await applyConfig(admin4, cfg4);
    await admin4.query(`insert into data_synth.clients (id, client_number, name) values
      (gen_random_uuid(), 'C-0001', 'Acme Manufacturing'),
      (gen_random_uuid(), 'C-0002', 'Globex Corporation')`);
    await admin4.query(`insert into data_live.clients (id, client_number, name) values
      (gen_random_uuid(), 'C-9001', 'Beacon Manufacturing')`);
    await syncDatasetTerms(admin4, cfg4, "dev");
    await syncDatasetTerms(admin4, cfg4, "live");
  });

  afterAll(async () => {
    await admin4.end();
    await p4.end();
  });

  it("carries the source collection's label, not just the slug", async () => {
    const [b] = await loadTaxonomyBindings(admin4, cfg4, "cases", "dev");
    // The slug is slugified and lowercased; the label is the row's `name` verbatim.
    expect(b!.terms).toEqual([
      { slug: "c-0001", label: "Acme Manufacturing" },
      { slug: "c-0002", label: "Globex Corporation" },
    ]);
    expect(b!.slugs).toEqual(["c-0001", "c-0002"]);
  });

  it("scopes terms per env — dev and live see different clients", async () => {
    const [dev] = await loadTaxonomyBindings(admin4, cfg4, "cases", "dev");
    const [live] = await loadTaxonomyBindings(admin4, cfg4, "cases", "live");
    expect(dev!.slugs).toEqual(["c-0001", "c-0002"]);
    expect(live!.terms).toEqual([{ slug: "c-9001", label: "Beacon Manufacturing" }]);
  });

  it("re-syncing picks up a renamed client without duplicating the term", async () => {
    await admin4.query(
      `update data_synth.clients set name='Acme Holdings' where client_number='C-0001'`,
    );
    await syncDatasetTerms(admin4, cfg4, "dev");
    const [b] = await loadTaxonomyBindings(admin4, cfg4, "cases", "dev");
    expect(b!.terms).toHaveLength(2);
    expect(b!.terms[0]).toEqual({ slug: "c-0001", label: "Acme Holdings" });
  });

  it("refuses two source values that collide on one slug instead of merging them", async () => {
    // Folding these together would silently widen every grant scoped to `acme-inc`.
    await admin4.query(`insert into data_synth.clients (id, client_number, name) values
      (gen_random_uuid(), 'Acme, Inc.', 'Acme One'),
      (gen_random_uuid(), 'Acme Inc',   'Acme Two')`);
    await expect(syncDatasetTerms(admin4, cfg4, "dev")).rejects.toThrow(
      /both slugify to "acme-inc"/,
    );
    await admin4.query(
      `delete from data_synth.clients where client_number in ('Acme, Inc.','Acme Inc')`,
    );
  });

  it("refuses a source value with no slug-safe characters", async () => {
    await admin4.query(`insert into data_synth.clients (id, client_number, name)
      values (gen_random_uuid(), '!!!', 'Punctuation Only')`);
    await expect(syncDatasetTerms(admin4, cfg4, "dev")).rejects.toThrow(/no slug-safe characters/);
    await admin4.query(`delete from data_synth.clients where client_number='!!!'`);
  });
});

// A forged `documentFilter`/`documentFilters` in the approve body is covered where it can
// actually be exercised — apps/web/test/grant-approve.integration.test.ts, which drives
// buildApproval directly. A placeholder here would only look like coverage.
