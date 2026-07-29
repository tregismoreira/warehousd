import type { Pool } from "pg";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export const MAX_KEY_LIFETIME_DAYS = 365;

// whd_live_<id>_<random>_<checksum> or whd_dev_<id>_<random>_<checksum>
// A never-expiring credential is philosophically opposite to purpose-bound expiring grants.
export const CLIENT_SECRET_REGEX = /^whd_(dev|live)_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+$/i;

export function exportSecretRegex(): RegExp {
  return CLIENT_SECRET_REGEX;
}

// Generate a secret with format: prefix_id_random_checksum, where checksum validates the rest
export function generateSecret(env: "dev" | "live", id: string): string {
  const random = randomBytes(12).toString("hex");
  const prefix = `whd_${env}_${id}`;
  const checksum = computeChecksum(`${prefix}_${random}`);
  return `${prefix}_${random}_${checksum}`;
}

// CRC-like checksum over prefix and random, so obviously-malformed keys are rejected
// before any database work.
function computeChecksum(s: string): string {
  let crc = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  // `>>> 0` coerces to unsigned. Without it JS's bitwise ops leave a SIGNED 32-bit int, so
  // about half of all checksums render with a leading "-" — which fails the key format regex.
  // Every key carrying one would be rejected by the very validator that issued it.
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export function validateSecretFormat(secret: string): boolean {
  if (!CLIENT_SECRET_REGEX.test(secret)) return false;
  const parts = secret.split("_");
  if (parts.length !== 5) return false;
  const prefix = parts.slice(0, 3).join("_");
  const random = parts[3];
  const checksum = parts[4];
  return checksum === computeChecksum(`${prefix}_${random}`);
}

// Extract env from secret without storing the plaintext
export function envFromSecret(secret: string): "dev" | "live" | null {
  const match = secret.match(/^whd_(dev|live)_/i);
  if (match && match[1]) return match[1].toLowerCase() as "dev" | "live";
  return null;
}

// Extract the prefix (without random/checksum) for lookup
export function getPrefixFromSecret(secret: string): string {
  const parts = secret.split("_");
  if (parts.length !== 5) return "";
  return parts.slice(0, 3).join("_");
}

// Derive the display prefix (env + id, no random/checksum) for showing to user
export function getDisplayPrefix(secret: string): string {
  const parts = secret.split("_");
  if (parts.length !== 5) return "";
  return `${parts[0]}_${parts[1]}_${parts[2]}`;
}

export type ClientSecretInfo = {
  id: string;
  prefix: string;
  createdAt: Date;
  createdBy: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export async function createClientSecret(
  db: Pool,
  clientId: string,
  orgId: string,
  expiresAt: Date,
  createdBy: string,
  env: "dev" | "live" = "dev",
): Promise<{ secret: string; id: string }> {
  // Enforce max lifetime: a never-expiring credential is philosophically opposite
  // to purpose-bound expiring grants.
  const maxExpiry = new Date();
  maxExpiry.setDate(maxExpiry.getDate() + MAX_KEY_LIFETIME_DAYS);
  if (expiresAt > maxExpiry) {
    throw new Error(`Secret expiry exceeds maximum ${MAX_KEY_LIFETIME_DAYS} days`);
  }

  // Check: max 2 unrevoked secrets per client
  const existing = await db.query(
    `select count(*)::int as cnt from app.client_secrets
     where client_id=$1 and revoked_at is null`,
    [clientId]);
  if (existing.rows[0].cnt >= 2) {
    throw new Error("Maximum 2 unrevoked secrets per client");
  }

  // The env goes INTO the secret: a leaked key should say on sight which environment it
  // reaches, which is the whole point of a self-identifying prefix.
  const secretId = randomBytes(6).toString("hex");
  const secret = generateSecret(env, secretId);

  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, 64);
  const secretHash = `${salt.toString("hex")}:${(hash as Buffer).toString("hex")}`;

  const prefix = getPrefixFromSecret(secret);
  const r = await db.query(
    `insert into app.client_secrets
       (client_id, org_id, prefix, secret_hash, created_at, created_by, expires_at)
     values ($1, $2, $3, $4, now(), $5, $6)
     returning id`,
    [clientId, orgId, prefix, secretHash, createdBy, expiresAt]);

  return { secret, id: r.rows[0].id };
}

export async function verifyClientSecret(
  db: Pool,
  secret: string,
): Promise<{ clientId: string; orgId: string; id: string } | null> {
  // Fast path: reject obviously malformed secrets without a database round trip
  if (!validateSecretFormat(secret)) return null;

  const prefix = getPrefixFromSecret(secret);
  const r = await db.query(
    `select id, client_id, org_id, secret_hash, revoked_at, expires_at
     from app.client_secrets where prefix=$1 limit 1`,
    [prefix]);

  if (r.rowCount === 0) return null;

  const row = r.rows[0];

  // Reject revoked secrets immediately
  if (row.revoked_at) return null;

  // Reject expired secrets
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  // Verify the secret hash using constant-time comparison
  const [saltHex, hashHex] = row.secret_hash.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const storedHash = Buffer.from(hashHex, "hex");
  const testHash = (await scryptAsync(secret, salt, 64)) as Buffer;

  // timingSafeEqual RETURNS the verdict; it only throws on a length mismatch. Discarding the
  // return value and catching the throw accepts every secret that shares a prefix.
  if (testHash.length !== storedHash.length) return null;
  if (!timingSafeEqual(testHash, storedHash)) return null;

  // Update last_used_at
  await db.query(
    `update app.client_secrets set last_used_at=now() where id=$1`,
    [row.id]);

  return { clientId: row.client_id, orgId: row.org_id, id: row.id };
}

// Rotation issues a SECOND live secret and leaves the first working. That overlap is the
// feature: a caller redeploys with the new key at its own pace, then revokes the old one
// explicitly. Revoking here would make every rotation an outage.
export async function rotateClientSecret(
  db: Pool,
  clientId: string,
  orgId: string,
  oldSecretId: string,
  expiresAt: Date,
  createdBy: string,
  env: "dev" | "live" = "dev",
): Promise<{ secret: string; id: string }> {
  const old = await db.query(
    `select id from app.client_secrets
     where id=$1 and client_id=$2 and org_id=$3 and revoked_at is null`,
    [oldSecretId, clientId, orgId]);
  if (old.rowCount === 0) throw new Error("Old secret not found or already revoked");

  // createClientSecret enforces the ceiling of two unrevoked secrets, so a client cannot
  // accumulate keys by rotating repeatedly without ever revoking.
  return createClientSecret(db, clientId, orgId, expiresAt, createdBy, env);
}

export async function revokeClientSecret(db: Pool, secretId: string): Promise<void> {
  await db.query(
    `update app.client_secrets set revoked_at=now() where id=$1`,
    [secretId]);
}

export async function listClientSecrets(
  db: Pool,
  clientId: string,
  orgId: string,
): Promise<ClientSecretInfo[]> {
  const r = await db.query(
    `select id, prefix, created_at, created_by, expires_at, last_used_at, revoked_at
     from app.client_secrets
     where client_id=$1 and org_id=$2
     order by created_at desc`,
    [clientId, orgId]);

  return r.rows.map((row) => ({
    id: row.id,
    prefix: row.prefix,
    createdAt: new Date(row.created_at),
    createdBy: row.created_by,
    expiresAt: new Date(row.expires_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  }));
}
