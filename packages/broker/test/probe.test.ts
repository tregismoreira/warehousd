import { it, expect, beforeAll, afterAll, vi, describe } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { loadConfig } from "../src/config/load";
import { DENIED_CANARY, SSN_CANARY } from "./fixtures/canaries";
import type { QueryIntent } from "../src/types";

const cfg = loadConfig(join(__dirname, "../../../examples/meridian"));
const allProbes = JSON.parse(readFileSync(join(__dirname, "fixtures/probes.json"), "utf8")) as
  { name: string; surface?: string; intent: QueryIntent; expect: "allowed" | "refused" }[];
// Skip document-specific probes (tested separately via searchDocuments)
const probes = allProbes.filter(p => !p.surface || p.surface === "query");

let p: Provisioned, admin: Pool, pools: Pools, logs: string[] = [];
beforeAll(async () => {
  p = await provision("probe"); admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin); await applyConfig(admin, cfg);
  // plant canaries directly into denied columns
  const dep = (await admin.query(`insert into data_synth.departments (id,name) values (gen_random_uuid(),'Fin') returning id`)).rows[0].id;
  const person = (await admin.query(
    `insert into data_synth.people (id,full_name,email,department_id,home_address,phone)
     values (gen_random_uuid(),'P','p@x', $1, $2, '555') returning id`, [dep, DENIED_CANARY])).rows[0].id;
  await admin.query(
    `insert into data_synth.salaries (id,person_id,job_title,base_salary,currency,effective_date,ssn)
     values (gen_random_uuid(), $1, 'Senior Accountant', 100000,'USD','2023-01-01',$2)`, [person, SSN_CANARY]);
  // grant mia EVERYTHING grantable so the ONLY thing blocking canaries is posture, not missing grant
  for (const [c, fields] of [
    ["people", ["id","full_name","email","department_name","department_id"]],
    ["salaries", ["id","person_id","job_title","base_salary","currency","effective_date"]],
  ] as const)
    await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status)
      values ('mia',$1,$2,'dev','approved')`, [c, fields]);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { logs.push(a.join(" ")); });
});
afterAll(async () => { vi.restoreAllMocks(); await admin.end(); await pools.end(); await p.end(); });

it("no probe leaks any denied canary; outcomes match expectations", async () => {
  const broker = makeBroker(pools, cfg);
  for (const probe of probes) {
    const r = await broker.query({ userId: "mia", orgId: "default", env: "dev" }, probe.intent);
    const outcome = r.ok ? "allowed" : "refused";
    expect(outcome, `probe "${probe.name}"`).toBe(probe.expect);
    const payload = JSON.stringify(r);
    for (const canary of [DENIED_CANARY, SSN_CANARY]) {
      expect(payload.includes(canary), `canary in response of "${probe.name}"`).toBe(false);
    }
  }
  // no canary reached any captured log line
  for (const canary of [DENIED_CANARY, SSN_CANARY])
    expect(logs.join("\n").includes(canary)).toBe(false);
  // the table still exists (sql-injection probe did not drop it)
  const still = await admin.query(`select count(*)::int c from data_synth.people`);
  expect(still.rows[0].c).toBeGreaterThan(0);
});

// A collection name every object literal already answers to. `cfg.collections[name]` is a
// property read, not a membership test, so these returned a truthy non-collection, sailed
// past the unknown_collection check and threw on `.fields`. The throw is not the problem —
// refuse() is what writes the audit row, so a probe using one of these names left no trace
// in the trail at all.
it("collection names inherited from Object.prototype refuse cleanly and are audited", async () => {
  const broker = makeBroker(pools, cfg);
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    for (const r of [
      await broker.query({ userId: "mia", orgId: "default", env: "dev" }, { collection: name, fields: ["id"] }),
      await broker.describeCollection({ userId: "mia", orgId: "default", env: "dev" }, name),
      await broker.searchDocuments({ userId: "mia", orgId: "default", env: "dev" }, { collection: name, q: "x" }),
    ]) {
      expect("ok" in r && r.ok, name).toBe(false);
      const refusal = r as { reason: string; auditId: string };
      expect(refusal.reason, name).toBe("unknown_collection");
      const row = await admin.query(
        `select outcome, reason from app.audit_events where id = $1`, [refusal.auditId]);
      expect(row.rows[0], name).toMatchObject({ outcome: "refused", reason: "unknown_collection" });
    }
  }
});

describe("document_filter bypass and hostile-q probes (design §8 test 4)", () => {
  let p2: Provisioned;
  let db2: Pool;
  let pools2: Pools;
  let logs2: string[] = [];
  afterAll(async () => { vi.restoreAllMocks(); await db2?.end(); await pools2?.end(); await p2?.end(); });

  beforeAll(async () => {
    p2 = await provision("probe-doc");
    db2 = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db2);

    const docCfg = {
      project: "t",
      server: { port: 1 },
      synthetic: { documents_per_collection: {} },
      collections: {
        policies: {
          type: "file" as const,
          description: "Company policies",
          source: "./x",
          fields: {
            title: { posture: "allow" as const },
            content: { posture: "allow" as const },
            path: { posture: "deny" as const },
          },
        },
      },
    };

    await applyConfig(db2, docCfg);

    // Seed 2 fixture docs: normal one + restricted one with canary
    const { mkdtempSync } = await import("node:fs");
    const tmpDir = mkdtempSync("probe-doc-");
    const fs = await import("node:fs");
    fs.mkdirSync(`${tmpDir}/restricted`, { recursive: true });
    fs.writeFileSync(`${tmpDir}/normal.md`, "# Normal Policy\n\nThis is a work policy.");
    fs.writeFileSync(`${tmpDir}/restricted/secret.md`, `# Secret Policy\n\n${(await import("./fixtures/canaries")).DOC_RESTRICTED_CANARY}`);

    const { indexCollection } = await import("../src/indexing");
    await indexCollection(db2, "dev", "policies", tmpDir);
    fs.rmSync(tmpDir, { recursive: true });

    // Approve grant with document_filter excluding the restricted document
    const { approveGrant } = await import("../src/grants/manage");
    const grantRes = await db2.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status)
       values ($1, $2, $3, $4, $5) returning id`,
      ["u_doc", "policies", ["title", "content"], "dev", "pending"]
    );
    const grantId = grantRes.rows[0].id;
    await approveGrant(db2, grantId, "admin", {
      documentFilter: { field: "path", op: "in", value: ["normal.md"] },
    });

    pools2 = createPools({ app: p2.urls.admin, dev: p2.urls.dev, live: p2.urls.live });
    logs2 = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs2.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { logs2.push(a.join(" ")); });
  });

  it("hostile q and document_filter bypass probes do not leak canary; outcomes match", async () => {
    const { DOC_RESTRICTED_CANARY } = await import("./fixtures/canaries");
    const broker = makeBroker(pools2, {
      project: "t",
      server: { port: 1 },
      synthetic: { documents_per_collection: {} },
      collections: {
        policies: {
          type: "file" as const,
          description: "Company policies",
          source: "./x",
          fields: {
            title: { posture: "allow" as const },
            content: { posture: "allow" as const },
            path: { posture: "deny" as const },
          },
        },
      },
    });

    const allProbes = JSON.parse(readFileSync(join(__dirname, "fixtures/probes.json"), "utf8")) as
      { name: string; surface?: string; intent: any; expect: "allowed" | "refused" }[];
    const newProbes = allProbes.filter((p) => p.surface === "searchDocuments" || p.name === "document-filter-bypass-via-filters");

    for (const probe of newProbes) {
      const surface = probe.surface || "query";
      const r = surface === "searchDocuments"
        ? await broker.searchDocuments({ userId: "u_doc", orgId: "default", env: "dev" }, probe.intent)
        : await broker.query({ userId: "u_doc", orgId: "default", env: "dev" }, probe.intent);
      const outcome = r.ok ? "allowed" : "refused";
      expect(outcome, `probe "${probe.name}"`).toBe(probe.expect);
      const payload = JSON.stringify(r);
      expect(payload.includes(DOC_RESTRICTED_CANARY), `canary in response of "${probe.name}"`).toBe(false);
    }

    // no canary reached any log
    expect(logs2.join("\n").includes(DOC_RESTRICTED_CANARY)).toBe(false);
  });
});

describe("unhandled Postgres errors are caught and audited (design §10 test 4)", () => {
  it("filter value type mismatch (invalid uuid) is caught and returns internal_error", async () => {
    const broker = makeBroker(pools, cfg);
    const intent: QueryIntent = {
      collection: "people",
      filters: [{ field: "id", op: "gt", value: "x" }],
    };
    const r = await broker.query({ userId: "mia", orgId: "default", env: "dev" }, intent);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("internal_error");
      expect(r.auditId).toBeTruthy();
      // Verify audit row exists
      const auditRow = await admin.query(
        `select outcome, reason from app.audit_events where id = $1`, [r.auditId]
      );
      expect(auditRow.rows.length).toBe(1);
      expect(auditRow.rows[0]).toMatchObject({ outcome: "refused", reason: "internal_error" });
      // Verify no Postgres error details leaked
      const payload = JSON.stringify(r);
      expect(payload.includes("invalid input syntax")).toBe(false);
      expect(payload.includes("uuid")).toBe(false);
    }
  });

  it("aggregate mismatch (sum on text field) is caught and returns internal_error", async () => {
    const broker = makeBroker(pools, cfg);
    const intent: QueryIntent = {
      collection: "people",
      aggregate: [{ fn: "sum", field: "full_name" }],
      groupBy: ["department_name"],
    };
    const r = await broker.query({ userId: "mia", orgId: "default", env: "dev" }, intent);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("internal_error");
      expect(r.auditId).toBeTruthy();
      // Verify audit row exists
      const auditRow = await admin.query(
        `select outcome, reason from app.audit_events where id = $1`, [r.auditId]
      );
      expect(auditRow.rows.length).toBe(1);
      expect(auditRow.rows[0]).toMatchObject({ outcome: "refused", reason: "internal_error" });
      // Verify no Postgres error details leaked
      const payload = JSON.stringify(r);
      expect(payload.includes("function sum")).toBe(false);
      expect(payload.includes("does not exist")).toBe(false);
    }
  });

  it("orderBy field not in groupBy is caught and returns internal_error", async () => {
    const broker = makeBroker(pools, cfg);
    const intent: QueryIntent = {
      collection: "people",
      aggregate: [{ fn: "count", field: "id" }],
      groupBy: ["department_name"],
      orderBy: { field: "id", dir: "asc" },
    };
    const r = await broker.query({ userId: "mia", orgId: "default", env: "dev" }, intent);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("internal_error");
      expect(r.auditId).toBeTruthy();
      // Verify audit row exists
      const auditRow = await admin.query(
        `select outcome, reason from app.audit_events where id = $1`, [r.auditId]
      );
      expect(auditRow.rows.length).toBe(1);
      expect(auditRow.rows[0]).toMatchObject({ outcome: "refused", reason: "internal_error" });
      // Verify no Postgres error details leaked
      const payload = JSON.stringify(r);
      expect(payload.includes("must appear in the GROUP BY")).toBe(false);
      expect(payload.includes("GROUP BY")).toBe(false);
    }
  });
});
