import type { Pool } from "pg";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export const MAX_KEY_LIFETIME_DAYS = 365;

// whd_live_<id>_<random>_<checksum> or whd_dev_<id>_<random>_<checksum>
// A never-expiring credential is philosophically opposite to purpose-bound expiring grants.
export const CLIENT_SECRET_REGEX = /^whd_(dev|live)_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+$/i;

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

// The env a key was minted for, read from its own prefix.
//
// A ceiling as well as a label. verifyClientSecret reports it so a leaked key can be triaged on
// sight, and /v1/token narrows the client policy by it (narrowPolicyToKeyEnv) before resolving an
// env scope — so a `whd_dev_` key can never yield `env:live`, however the policy is widened later.
// It only ever narrows: it cannot grant an env the policy withholds, and `env:live` still requires
// the user's live-grant eligibility on top (see resolveIssuedEnvScope).
//
// The opt-out that used to be missing is the admin route's `env` field: a live key is minted
// explicitly, so capping a dev-prefixed key at dev no longer caps every client at dev.
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
    [clientId],
  );
  if (existing.rows[0].cnt >= 2) {
    throw new Error("Maximum 2 unrevoked secrets per client");
  }

  // The env goes INTO the secret: it is both how a leaked key is triaged on sight and the ceiling
  // /v1/token narrows the client policy by. See envFromSecret.
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
    [clientId, orgId, prefix, secretHash, createdBy, expiresAt],
  );

  return { secret, id: r.rows[0].id };
}

// `env` is the ceiling encoded in the key's own prefix — see envFromSecret. Callers that issue
// tokens must intersect it with whatever the client policy and the user's grants allow, so a
// `whd_dev_*` key cannot reach live however the policy is later widened. `/v1/token` does this
// through narrowPolicyToKeyEnv; a new token-issuing path that skips it reopens the hole.
export async function verifyClientSecret(
  db: Pool,
  secret: string,
): Promise<{ clientId: string; orgId: string; id: string; env: "dev" | "live" } | null> {
  // Fast path: reject obviously malformed secrets without a database round trip
  if (!validateSecretFormat(secret)) return null;

  const prefix = getPrefixFromSecret(secret);
  const r = await db.query(
    `select id, client_id, org_id, prefix, secret_hash, revoked_at, expires_at
     from app.client_secrets where prefix=$1 limit 1`,
    [prefix],
  );

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
  await db.query(`update app.client_secrets set last_used_at=now() where id=$1`, [row.id]);

  // From the stored prefix, not the presented string: same value, but unambiguously server-side.
  // The format regex above guarantees the prefix carries one of the two.
  return {
    clientId: row.client_id,
    orgId: row.org_id,
    id: row.id,
    env: envFromSecret(row.prefix) ?? "dev",
  };
}

// Rotation issues a SECOND live secret and leaves the first working. That overlap is the
// feature: a caller redeploys with the new key at its own pace, then revokes the old one
// explicitly. Revoking here would make every rotation an outage.
//
// The env is read off the secret being rotated rather than taken as an argument. Rotation replaces
// a credential, it does not re-scope one: a caller-supplied env would make a rotation either a
// silent downgrade (a live key coming back capped at dev, breaking the deployment mid-rotation) or
// a silent escalation. Choosing an env is what minting a new key is for.
export async function rotateClientSecret(
  db: Pool,
  clientId: string,
  orgId: string,
  oldSecretId: string,
  expiresAt: Date,
  createdBy: string,
): Promise<{ secret: string; id: string }> {
  const old = await db.query(
    `select prefix from app.client_secrets
     where id=$1 and client_id=$2 and org_id=$3 and revoked_at is null`,
    [oldSecretId, clientId, orgId],
  );
  if (old.rowCount === 0) throw new Error("Old secret not found or already revoked");

  // createClientSecret enforces the ceiling of two unrevoked secrets, so a client cannot
  // accumulate keys by rotating repeatedly without ever revoking.
  return createClientSecret(
    db,
    clientId,
    orgId,
    expiresAt,
    createdBy,
    envFromSecret(old.rows[0].prefix) ?? "dev",
  );
}

// Scoped by client and org, not by secret id alone.
//
// A secret id is a uuid the caller supplies, so `where id=$1` revokes any secret in any org for
// anyone who can guess or observe one. The revoke route did check ownership first — but as its own
// SELECT, which is a guarantee the caller provides rather than one this function enforces, and the
// next caller is the one that forgets. Requiring the scope makes the safe call the only call.
//
// Returns whether a row matched, so a caller can answer `not_found` without a second query.
export async function revokeClientSecret(
  db: Pool,
  secretId: string,
  clientId: string,
  orgId: string,
): Promise<boolean> {
  const r = await db.query(
    `update app.client_secrets set revoked_at=now()
     where id=$1 and client_id=$2 and org_id=$3`,
    [secretId, clientId, orgId],
  );
  return (r.rowCount ?? 0) > 0;
}

// What the client's usable keys can reach, read from their prefixes.
//
// Exists because promoting a client's policy to `env:live` is meaningless — and now silently so —
// when every key it holds is `whd_dev_`: the prefix is a ceiling, so the widened policy would
// never be reached. The promote route asks this first and refuses rather than recording a
// promotion that does nothing.
//
// `hasSecrets` is separate from `liveCapable` on purpose. A client with NO keys at all is an
// OAuth/DCR client whose env comes from the authorize flow, not from a prefix — promoting one is
// perfectly meaningful, and conflating "no keys" with "no live key" would break it.
//
// Scoped the same way verifyClientSecret is: revoked and expired keys cannot be presented, so
// they cannot make a promotion useful and must not make one look useful either.
export async function clientKeyEnvs(
  db: Pool,
  clientId: string,
  orgId: string,
): Promise<{ hasSecrets: boolean; liveCapable: boolean }> {
  const r = await db.query(
    `select prefix from app.client_secrets
     where client_id=$1 and org_id=$2 and revoked_at is null and expires_at > now()`,
    [clientId, orgId],
  );
  return {
    hasSecrets: (r.rowCount ?? 0) > 0,
    liveCapable: r.rows.some((row) => envFromSecret(row.prefix) === "live"),
  };
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
    [clientId, orgId],
  );

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
