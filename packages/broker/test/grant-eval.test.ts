import { it, expect, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { loadActiveGrant } from "../src/grants/eval";
import { makeCtx } from "./helpers/ctx";

let p: Provisioned;
let db: Pool;
afterAll(async () => {
  await db?.end();
  await p?.end();
});

it("returns the active approved grant and null for revoked/expired", async () => {
  p = await provision("granteval");
  db = testPool({ connectionString: p.urls.admin });
  await createAppSchema(db);

  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at)
     values ('mia','people', array['id','email'],'dev','approved', now() + interval '1 day')`,
  );
  const g = await loadActiveGrant(db, makeCtx({ userId: "mia" }), "people");
  expect(g?.allowedFields).toEqual(["id", "email"]);

  // revoked → none
  await db.query(`update app.grants set status='revoked' where user_id='mia'`);
  expect(await loadActiveGrant(db, makeCtx({ userId: "mia" }), "people")).toBeNull();

  // expired approved → none
  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at)
     values ('mia','people', array['id'],'dev','approved', now() - interval '1 hour')`,
  );
  expect(await loadActiveGrant(db, makeCtx({ userId: "mia" }), "people")).toBeNull();

  // wrong env → none (dev grant not visible to live)
  const g2 = await loadActiveGrant(db, makeCtx({ userId: "mia", env: "live" }), "people");
  expect(g2).toBeNull();
});

it("loadActiveGrant returns documentFilters as array when set, empty array otherwise", async () => {
  p = await provision("granteval2");
  db = testPool({ connectionString: p.urls.admin });
  await createAppSchema(db);

  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at,document_filter)
     values ('mia','policies', array['title'],'dev','approved', now() + interval '1 day', '[{"field":"path","op":"in","value":["hr/pto.md"]}]')`,
  );
  const g = await loadActiveGrant(db, makeCtx({ userId: "mia" }), "policies");
  expect(g?.documentFilter).toEqual([{ field: "path", op: "in", value: ["hr/pto.md"] }]);

  // Check that grants without document_filter get empty array
  await db.query(
    `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at)
     values ('mia2','policies', array['title'],'dev','approved', now() + interval '1 day')`,
  );
  const g2 = await loadActiveGrant(db, makeCtx({ userId: "mia2" }), "policies");
  expect(g2?.documentFilter).toEqual([]);
});
