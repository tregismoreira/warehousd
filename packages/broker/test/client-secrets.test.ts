import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import {
  createClientSecret, verifyClientSecret, rotateClientSecret, revokeClientSecret,
  listClientSecrets, MAX_KEY_LIFETIME_DAYS, envFromSecret, getDisplayPrefix,
  CLIENT_SECRET_REGEX, validateSecretFormat, generateSecret,
} from "../src/credentials/keys";

let p: Provisioned;
afterAll(async () => { await p?.end(); });

// app.client_secrets has an FK to app.client_policies: a credential only exists for a client
// IT has registered. Every test that provisions a database has to seed that parent row.
const seedClient = (db: Pool) => db.query(
  `insert into app.client_policies (client_id, display_name, org_id)
   values ('test_client', 'Test Client', 'default') on conflict (client_id) do nothing`);

describe("client secrets", () => {
  it("secret format: prefix reveals env and nothing else", async () => {
    p = await provision("clientsecrets");
    const secret = "whd_live_abc123_xyz789_deadbeef";
    expect(CLIENT_SECRET_REGEX.test(secret)).toBe(true);
    expect(envFromSecret(secret)).toBe("live");
    expect(getDisplayPrefix(secret)).toBe("whd_live_abc123");
  });

  // The prefix is a ceiling, not a label: verifyClientSecret reports it so /v1/token can narrow
  // to it. It went unread anywhere while createClientSecret's comment claimed a leaked key
  // "should say on sight which environment it reaches".
  it("verification reports the env encoded in the key's own prefix", async () => {
    p = await provision("clientsecrets");
    const db = new Pool({ connectionString: p.urls.admin });
    try {
      await createAppSchema(db);
      await seedClient(db);

      const dev = await createClientSecret(
        db, "test_client", "default", new Date(Date.now() + 86_400_000), "tester", "dev");
      expect(await verifyClientSecret(db, dev.secret)).toMatchObject({ env: "dev" });
      await revokeClientSecret(db, dev.id, "test_client", "default");

      const live = await createClientSecret(
        db, "test_client", "default", new Date(Date.now() + 86_400_000), "tester", "live");
      expect(live.secret.startsWith("whd_live_")).toBe(true);
      expect(await verifyClientSecret(db, live.secret)).toMatchObject({ env: "live" });
    } finally {
      await db.end();
    }
  });

  it("malformed checksum rejected without database round trip", async () => {
    // A secret with invalid checksum should fail validation immediately
    const badSecret = "whd_live_abc123_xyz789_badchecksum";
    // It is shaped like a key, so the regex accepts it; only the checksum catches it, and it
    // does so with no database round trip.
    expect(CLIENT_SECRET_REGEX.test(badSecret)).toBe(true);
    expect(validateSecretFormat(badSecret)).toBe(false);
    expect(validateSecretFormat(generateSecret("live", "abc123"))).toBe(true);
  });

  it("secret is unrecoverable after creation", async () => {
    p = await provision("clientsecrets");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await seedClient(db);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const { secret, id } = await createClientSecret(
      db, "test_client", "default", expiresAt, "admin");

    // Verify the secret works
    const verified = await verifyClientSecret(db, secret);
    expect(verified).not.toBeNull();
    expect(verified?.clientId).toBe("test_client");

    // Check database: only hash is stored, never the plaintext
    const row = await db.query(`select secret_hash from app.client_secrets where id=$1`, [id]);
    expect(row.rows[0].secret_hash).toContain(":");
    expect(row.rows[0].secret_hash).not.toContain(secret);

    // Assert plaintext never appears in any query result
    const all = await db.query(`select * from app.client_secrets where id=$1`, [id]);
    const stringified = JSON.stringify(all.rows[0]);
    expect(stringified).not.toContain(secret);

    await db.end();
  });

  it("revoked key fails the next verify with no expiry wait", async () => {
    p = await provision("clientsecrets");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await seedClient(db);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const { secret, id } = await createClientSecret(
      db, "test_client", "default", expiresAt, "admin");

    // Verify before revocation
    let verified = await verifyClientSecret(db, secret);
    expect(verified).not.toBeNull();

    // Revoke it
    await revokeClientSecret(db, id, "test_client", "default");

    // Should now fail
    verified = await verifyClientSecret(db, secret);
    expect(verified).toBeNull();

    await db.end();
  });

  it("expired key is refused", async () => {
    p = await provision("clientsecrets");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await seedClient(db);

    const expiresAt = new Date();
    expiresAt.setTime(expiresAt.getTime() - 1000); // Already expired

    const { secret } = await createClientSecret(
      db, "test_client", "default", expiresAt, "admin");

    // Should fail verification
    const verified = await verifyClientSecret(db, secret);
    expect(verified).toBeNull();

    await db.end();
  });

  it("both secrets verify during rotation window; retired one stops on revoke", async () => {
    p = await provision("clientsecrets");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await seedClient(db);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // Create first secret
    const { secret: secret1, id: id1 } = await createClientSecret(
      db, "test_client", "default", expiresAt, "admin");

    // Rotate (creates second secret)
    const { secret: secret2, id: id2 } = await rotateClientSecret(
      db, "test_client", "default", id1, expiresAt, "admin");

    // Both should verify
    let v1 = await verifyClientSecret(db, secret1);
    let v2 = await verifyClientSecret(db, secret2);
    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();

    // Revoke the old one
    await revokeClientSecret(db, id1, "test_client", "default");

    // Now secret1 fails, secret2 still works
    v1 = await verifyClientSecret(db, secret1);
    v2 = await verifyClientSecret(db, secret2);
    expect(v1).toBeNull();
    expect(v2).not.toBeNull();

    await db.end();
  });

  it("third unrevoked secret is refused", async () => {
    p = await provision("clientsecrets");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await seedClient(db);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // Create first
    const s1 = await createClientSecret(db, "test_client", "default", expiresAt, "admin");
    // Rotate to second
    const s2 = await rotateClientSecret(db, "test_client", "default", s1.id, expiresAt, "admin");
    // Try to create third without revoking one
    await expect(createClientSecret(db, "test_client", "default", expiresAt, "admin"))
      .rejects.toThrow("Maximum 2 unrevoked secrets per client");

    await db.end();
  });

  it("creation beyond MAX_KEY_LIFETIME_DAYS is refused", async () => {
    p = await provision("clientsecrets");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await seedClient(db);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + MAX_KEY_LIFETIME_DAYS + 1);

    await expect(createClientSecret(db, "test_client", "default", expiresAt, "admin"))
      .rejects.toThrow(`exceeds maximum ${MAX_KEY_LIFETIME_DAYS} days`);

    await db.end();
  });

  it("listClientSecrets never returns a hash", async () => {
    p = await provision("clientsecrets");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await seedClient(db);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const { secret } = await createClientSecret(
      db, "test_client", "default", expiresAt, "admin");

    const list = await listClientSecrets(db, "test_client", "default");
    expect(list).toHaveLength(1);
    expect(list[0]).toHaveProperty("prefix");
    expect(list[0]).toHaveProperty("createdAt");
    // Ensure the secret hash was never returned
    const stringified = JSON.stringify(list[0]);
    expect(stringified).not.toContain(secret);
    expect(stringified).not.toContain("secret_hash");

    await db.end();
  });
});

describe("revokeClientSecret scope", () => {
  it("refuses to revoke a secret belonging to another client or org", async () => {
    // The signature used to be (db, secretId) and matched on the id alone, so any caller holding
    // a secret id could revoke it regardless of which client or tenant owned it. The route
    // compensated with its own ownership SELECT; the library now enforces it.
    p = await provision("clientsecrets");
    const db = new Pool({ connectionString: p.urls.admin });
    try {
      await createAppSchema(db);
      await seedClient(db);
      const expiresAt = new Date(Date.now() + 86_400_000);
      const { secret, id } = await createClientSecret(db, "test_client", "default", expiresAt, "admin");

      expect(await revokeClientSecret(db, id, "other_client", "default")).toBe(false);
      expect(await revokeClientSecret(db, id, "test_client", "other_org")).toBe(false);
      // Still usable — a refused revoke must not half-apply.
      expect(await verifyClientSecret(db, secret)).not.toBeNull();

      expect(await revokeClientSecret(db, id, "test_client", "default")).toBe(true);
      expect(await verifyClientSecret(db, secret)).toBeNull();
      // Idempotence: revoking again matches the row but changes nothing meaningful.
      expect(await revokeClientSecret(db, id, "test_client", "default")).toBe(true);
    } finally {
      await db.end();
    }
  });
});
