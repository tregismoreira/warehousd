import { it, expect, afterAll } from "vitest";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";

let p: Provisioned;
afterAll(async () => {
  await p?.end();
});

it("data roles cannot UPDATE or DELETE audit_events (test 9)", async () => {
  p = await provision("auditro");
  const admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await admin.query(`insert into app.audit_events (user_id,outcome) values ('u','allowed')`);
  await admin.end();

  const dev = testPool({ connectionString: p.urls.dev });
  await expect(dev.query(`update app.audit_events set outcome='x'`)).rejects.toThrow();
  await expect(dev.query(`delete from app.audit_events`)).rejects.toThrow();
  // but insert is allowed
  await dev.query(`insert into app.audit_events (user_id,outcome) values ('u2','refused')`);
  await dev.end();
});
