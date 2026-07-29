import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { generateSynthetic } from "../src/synthetic/generate";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "t", server: { port: 1 }, synthetic: { documents_per_collection: { people: 12 } },
  collections: { people: { description: "dir", fields: {
    id: { type: "uuid", posture: "allow", pk: true },
    full_name: { type: "text", posture: "allow" },
    email: { type: "text", posture: "allow" },
    home_address: { type: "text", posture: "deny" },
  }}},
};

let p: Provisioned; let admin: Pool; let pools: Pools; let broker: ReturnType<typeof makeBroker>;
beforeAll(async () => {
  p = await provision("brokerq");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  await generateSynthetic(admin, cfg, 7);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

it("no grant → no_grant, still audited", async () => {
  const r = await broker.query({ userId: "u", orgId: "default", env: "dev", via: "session" }, { collection: "people" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("no_grant");
  const a = await admin.query(`select outcome, reason from app.audit_events where id=$1`, [r.auditId]);
  expect(a.rows[0]).toEqual({ outcome: "refused", reason: "no_grant" });
});

it("grant excluding email → requesting email is field_denied", async () => {
  await admin.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status)
     values ('u2','people', array['id','full_name'],'dev','approved')`);
  const r = await broker.query({ userId: "u2", orgId: "default", env: "dev", via: "session" },
    { collection: "people", fields: ["id", "email"] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("field_denied");
});

it("grant excluding email → default fields omit the email key entirely (absent, not null)", async () => {
  const r = await broker.query({ userId: "u2", orgId: "default", env: "dev", via: "session" }, { collection: "people", limit: 3 });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.fieldsReturned.sort()).toEqual(["full_name", "id"]);
    for (const row of r.documents) {
      expect("email" in row).toBe(false);
      expect("home_address" in row).toBe(false);
    }
  }
});

it("unknown collection / unknown field", async () => {
  const r1 = await broker.query({ userId: "u2", orgId: "default", env: "dev", via: "session" }, { collection: "nope" });
  if (!r1.ok) expect(r1.reason).toBe("unknown_collection");
  const r2 = await broker.query({ userId: "u2", orgId: "default", env: "dev", via: "session" },
    { collection: "people", fields: ["id", "ghost"] });
  if (!r2.ok) expect(r2.reason).toBe("unknown_field");
});

describe("document_filter on file collections", () => {
  it("document-filtered documents are silently absent (design test 3)", async () => {
    const docCfg: WarehousdConfig = {
      project: "t", server: { port: 1 }, synthetic: { documents_per_collection: {} },
      collections: {
        policies: {
          type: "file" as const,
          description: "d",
          source: "./x",
          fields: {
            title: { posture: "allow" as const },
            content: { posture: "allow" as const },
            path: { posture: "deny" as const },
          },
        },
      },
    };
    const pDoc = await provision("brokerq-doc");
    const dbDoc = new Pool({ connectionString: pDoc.urls.admin });
    await createAppSchema(dbDoc);
    await applyConfig(dbDoc, docCfg);
    const poolsDoc = createPools({ app: pDoc.urls.admin, dev: pDoc.urls.dev, live: pDoc.urls.live });
    const brokerDoc = makeBroker(poolsDoc, docCfg);
    const ctx = { userId: "u3", orgId: "default", env: "dev", via: "session" as const };

    // Seed documents
    const docRes = await dbDoc.query(
      `insert into data_synth."policies__files" (id,title,path,owner,checksum,updated_at)
       values (gen_random_uuid(),'PTO Policy','hr/pto.md',null,'c1',now()),
              (gen_random_uuid(),'Benefits Policy','hr/benefits.md',null,'c2',now())
       returning id`);
    const docIds = docRes.rows.map((r: any) => r.id);
    await dbDoc.query(
      `insert into data_synth."policies__documents" (id,file_id,document_seq,content)
       values (gen_random_uuid(),$1,0,'PTO content'),
              (gen_random_uuid(),$2,0,'Benefits content')`,
      [docIds[0], docIds[1]]);

    // Approve grant with documentFilters limiting to hr/pto.md only
    const grantRes = await dbDoc.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status)
       values ('u3', 'policies', array['title','content'], 'dev', 'pending') returning id`);
    const grantId = grantRes.rows[0].id;
    const { approveGrant } = await import("../src/grants/manage");
    await approveGrant(dbDoc, docCfg, grantId, "admin", {
      documentFilters: [{ field: "path", op: "in", value: ["hr/pto.md"] }],
    });

    const r = await brokerDoc.query(ctx, { collection: "policies", fields: ["title"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents.every((row: any) => row.title === "PTO Policy")).toBe(true);

    await dbDoc.end();
    await poolsDoc.end();
    await pDoc.end();
  });

  it("empty in-list document_filter returns zero documents, ok:true (design test 8, integration)", async () => {
    const docCfg: WarehousdConfig = {
      project: "t", server: { port: 1 }, synthetic: { documents_per_collection: {} },
      collections: {
        policies: {
          type: "file" as const,
          description: "d",
          source: "./x",
          fields: {
            title: { posture: "allow" as const },
            content: { posture: "allow" as const },
            path: { posture: "deny" as const },
          },
        },
      },
    };
    const pDoc = await provision("brokerq-empty");
    const dbDoc = new Pool({ connectionString: pDoc.urls.admin });
    await createAppSchema(dbDoc);
    await applyConfig(dbDoc, docCfg);
    const poolsDoc = createPools({ app: pDoc.urls.admin, dev: pDoc.urls.dev, live: pDoc.urls.live });
    const brokerDoc = makeBroker(poolsDoc, docCfg);
    const ctx = { userId: "u4", orgId: "default", env: "dev", via: "session" as const };

    // Seed documents
    const docRes = await dbDoc.query(
      `insert into data_synth."policies__files" (id,title,path,owner,checksum,updated_at)
       values (gen_random_uuid(),'PTO Policy','hr/pto.md',null,'c1',now()),
              (gen_random_uuid(),'Benefits Policy','hr/benefits.md',null,'c2',now())
       returning id`);
    const docIds = docRes.rows.map((r: any) => r.id);
    await dbDoc.query(
      `insert into data_synth."policies__documents" (id,file_id,document_seq,content)
       values (gen_random_uuid(),$1,0,'PTO content'),
              (gen_random_uuid(),$2,0,'Benefits content')`,
      [docIds[0], docIds[1]]);

    // Approve grant with empty documentFilters
    const grantRes = await dbDoc.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status)
       values ('u4', 'policies', array['title','content'], 'dev', 'pending') returning id`);
    const grantId = grantRes.rows[0].id;
    const { approveGrant } = await import("../src/grants/manage");
    await approveGrant(dbDoc, docCfg, grantId, "admin", {
      documentFilters: [{ field: "path", op: "in", value: [] }],
    });

    const r = await brokerDoc.query(ctx, { collection: "policies", fields: ["title"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documents).toHaveLength(0);

    await dbDoc.end();
    await poolsDoc.end();
    await pDoc.end();
  });
});
