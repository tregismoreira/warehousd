import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { loadActiveGrant } from "../src/grants/eval";

let p: Provisioned; let db: Pool;
afterAll(async () => { await db?.end(); await p?.end(); });

it("returns the active approved grant and null for revoked/expired", async () => {
  p = await provision("granteval");
  db = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(db);

  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at)
     values ('mia','people', array['id','email'],'dev','approved', now() + interval '1 day')`);
  const g = await loadActiveGrant(db, { userId: "mia", env: "dev", orgId: "default" }, "people");
  expect(g?.allowedFields).toEqual(["id", "email"]);

  // revoked → none
  await db.query(`update app.grants set status='revoked' where user_id='mia'`);
  expect(await loadActiveGrant(db, { userId: "mia", env: "dev", orgId: "default" }, "people")).toBeNull();

  // expired approved → none
  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at)
     values ('mia','people', array['id'],'dev','approved', now() - interval '1 hour')`);
  expect(await loadActiveGrant(db, { userId: "mia", env: "dev", orgId: "default" }, "people")).toBeNull();

  // wrong env → none (dev grant not visible to live)
  const g2 = await loadActiveGrant(db, { userId: "mia", env: "live", orgId: "default" }, "people");
  expect(g2).toBeNull();
});

it("loadActiveGrant returns documentFilter when set, null otherwise", async () => {
  p = await provision("granteval2");
  db = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(db);

  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at,document_filter)
     values ('mia','policies', array['title'],'dev','approved', now() + interval '1 day', '{"field":"path","op":"in","value":["hr/pto.md"]}')`);
  const g = await loadActiveGrant(db, { userId: "mia", env: "dev", orgId: "default" }, "policies");
  expect(g?.documentFilter).toEqual({ field: "path", op: "in", value: ["hr/pto.md"] });
});
