import type { Pool } from "pg";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { computeChecksum, MAX_KEY_LIFETIME_DAYS } from "./keys";

const scryptAsync = promisify(scrypt);

// whd_plat_<id>_<random>_<checksum> — a sibling of CLIENT_SECRET_REGEX (keys.ts), not an
// extension of it: a platform key must never be accepted where a client secret is expected, or
// the reverse, and the surest way to keep that true is two regexes rather than one widened one.
// The checksum comes from the same computeChecksum keys.ts uses — one hashing path, not two.
export const PLATFORM_KEY_REGEX = /^whd_plat_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+$/i;

function generatePlatformSecret(id: string): string {
  const random = randomBytes(12).toString("hex");
  const prefix = `whd_plat_${id}`;
  const checksum = computeChecksum(`${prefix}_${random}`);
  return `${prefix}_${random}_${checksum}`;
}

function validatePlatformSecretFormat(secret: string): boolean {
  if (!PLATFORM_KEY_REGEX.test(secret)) return false;
  const parts = secret.split("_");
  if (parts.length !== 5) return false;
  const prefix = parts.slice(0, 3).join("_");
  const random = parts[3];
  const checksum = parts[4];
  return checksum === computeChecksum(`${prefix}_${random}`);
}

function getPlatformPrefix(secret: string): string {
  const parts = secret.split("_");
  if (parts.length !== 5) return "";
  return parts.slice(0, 3).join("_");
}

export type PlatformKeyInfo = {
  id: string;
  label: string;
  prefix: string;
  managedWorkspaces: string[] | null;
  createdAt: Date;
  createdBy: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export async function createPlatformKey(
  db: Pool,
  i: { label: string; managedWorkspaces: string[] | null; expiresAt: Date; createdBy: string },
): Promise<{ secret: string; id: string }> {
  // Same ceiling as a client secret: a never-expiring credential is philosophically opposite to
  // purpose-bound expiring grants, and this key can create and delete tenants.
  const maxExpiry = new Date();
  maxExpiry.setDate(maxExpiry.getDate() + MAX_KEY_LIFETIME_DAYS);
  if (i.expiresAt > maxExpiry) {
    throw new Error(`Platform key expiry exceeds maximum ${MAX_KEY_LIFETIME_DAYS} days`);
  }

  const id = randomBytes(6).toString("hex");
  const secret = generatePlatformSecret(id);

  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, 64);
  const secretHash = `${salt.toString("hex")}:${(hash as Buffer).toString("hex")}`;

  const prefix = getPlatformPrefix(secret);
  const r = await db.query(
    `insert into app.platform_keys (label, prefix, secret_hash, managed_workspaces, created_by, expires_at)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [i.label, prefix, secretHash, i.managedWorkspaces, i.createdBy, i.expiresAt],
  );
  return { secret, id: r.rows[0].id as string };
}

export async function verifyPlatformKey(
  db: Pool,
  secret: string,
): Promise<{ id: string; label: string; managedWorkspaces: string[] | null } | null> {
  // Fast path: reject obviously malformed secrets without a database round trip.
  if (!validatePlatformSecretFormat(secret)) return null;

  const prefix = getPlatformPrefix(secret);
  const r = await db.query(
    `select id, label, secret_hash, managed_workspaces, revoked_at, expires_at
     from app.platform_keys where prefix=$1 limit 1`,
    [prefix],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];

  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  const [saltHex, hashHex] = row.secret_hash.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const storedHash = Buffer.from(hashHex, "hex");
  const testHash = (await scryptAsync(secret, salt, 64)) as Buffer;

  // timingSafeEqual RETURNS the verdict; it only throws on a length mismatch. Discarding the
  // return value and catching the throw accepts every secret that shares a prefix.
  if (testHash.length !== storedHash.length) return null;
  if (!timingSafeEqual(testHash, storedHash)) return null;

  await db.query(`update app.platform_keys set last_used_at=now() where id=$1`, [row.id]);

  return {
    id: row.id as string,
    label: row.label as string,
    managedWorkspaces: row.managed_workspaces as string[] | null,
  };
}

export async function revokePlatformKey(db: Pool, id: string): Promise<boolean> {
  const r = await db.query(
    `update app.platform_keys set revoked_at=now() where id=$1 and revoked_at is null`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

// Never the hash — this is a listing surface, not an authentication one.
export async function listPlatformKeys(db: Pool): Promise<PlatformKeyInfo[]> {
  const r = await db.query(
    `select id, label, prefix, managed_workspaces, created_at, created_by, expires_at,
            last_used_at, revoked_at
     from app.platform_keys order by created_at desc`,
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    label: row.label as string,
    prefix: row.prefix as string,
    managedWorkspaces: row.managed_workspaces as string[] | null,
    createdAt: new Date(row.created_at as string),
    createdBy: row.created_by as string,
    expiresAt: new Date(row.expires_at as string),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
  }));
}

// null managedWorkspaces = every workspace (the operator's own bootstrap key). A non-null array
// is the ACL that keeps two consuming apps on one deployment from reaching each other's tenants.
export function mayManageWorkspace(
  key: { managedWorkspaces: string[] | null },
  workspaceId: string,
): boolean {
  return key.managedWorkspaces === null || key.managedWorkspaces.includes(workspaceId);
}
