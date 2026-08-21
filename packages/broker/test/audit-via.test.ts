import { describe, it, expect, afterAll } from "vitest";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { writeAudit } from "../src/audit/write";

let p: Provisioned;
afterAll(async () => {
  await p?.end();
});

describe("audit via", () => {
  it("every outcome records via", async () => {
    p = await provision("auditvia");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    // Write allowed audit
    const auditId1 = await writeAudit(db, {
      userId: "user1",
      env: "dev",
      collection: "test",
      workspaceId: "default",
      intent: null,
      fieldsReturned: [],
      grantId: null,
      outcome: "allowed",
      reason: null,
      via: "session",
    });

    // Write refused audit
    const auditId2 = await writeAudit(db, {
      userId: "user2",
      env: "dev",
      collection: "test",
      workspaceId: "default",
      intent: null,
      fieldsReturned: [],
      grantId: null,
      outcome: "refused",
      reason: "no_grant",
      via: "oauth",
    });

    // Verify both have via recorded
    const r1 = await db.query(`select via from app.audit_events where id=$1`, [auditId1]);
    const r2 = await db.query(`select via from app.audit_events where id=$1`, [auditId2]);

    expect(r1.rows[0].via).toBe("session");
    expect(r2.rows[0].via).toBe("oauth");

    await db.end();
  });
});
