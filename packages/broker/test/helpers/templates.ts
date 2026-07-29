import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";

export const ADMIN = "postgres://postgres:postgres@127.0.0.1:54330/postgres";
export const BASE = "postgres://postgres:postgres@127.0.0.1:54330";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

// Databases are cluster-global and sibling checkouts share this Postgres — see docs/testing.md,
// "Running two checkouts at once". Without a per-checkout suffix one workspace's globalSetup
// would drop the template another workspace is mid-run cloning from, which surfaces as the
// second suite's schema vanishing rather than as a collision.
const SUFFIX = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);

export function templateName(kind: string): string {
  return `wh_tmpl_${kind}_${SUFFIX}`;
}

// Postgres refuses `create database x template t` while any other session is connected to t —
// including a second CREATE DATABASE copying the same template. One advisory lock serialises
// this checkout's workers; keying it off the same suffix keeps sibling checkouts from waiting
// on each other.
const LOCK_KEY = BigInt(`0x${SUFFIX}`).toString();

async function withTemplateLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ADMIN, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`select pg_advisory_lock($1)`, [LOCK_KEY]);
    try {
      return await fn(client);
    } finally {
      await client.query(`select pg_advisory_unlock($1)`, [LOCK_KEY]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// What a template's validity depends on: the broker's schema/DDL source, the Better Auth config
// its migration is generated from, and the lockfile — a better-auth bump changes the auth tables
// without touching a line of our own code.
//
// apps/web/lib is taken whole rather than just auth.ts: oauth.ts and sso.ts supply the plugin
// list, and a plugin decides which tables the Better Auth migration creates. examples/harbor is
// in for the web-with-data template, whose contents are that example's config and seed.
function fingerprintSources(): string[] {
  const out = [join(repoRoot, "pnpm-lock.yaml")];
  const walk = (dir: string, ext?: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, ext);
      else if (!ext || e.name.endsWith(ext)) out.push(p);
    }
  };
  walk(join(repoRoot, "packages/broker/src"), ".ts");
  walk(join(repoRoot, "apps/web/lib"), ".ts");
  walk(join(repoRoot, "examples/harbor"));
  return out;
}

let cachedFingerprint: string | undefined;

export function fingerprint(): string {
  if (cachedFingerprint) return cachedFingerprint;
  const h = createHash("sha256");
  for (const f of fingerprintSources()) h.update(readFileSync(f));
  return (cachedFingerprint = h.digest("hex"));
}

// The fingerprint lives in the database's comment rather than in a table: comments belong to
// the database object, so `create database ... template` does not copy it, and every cloned
// test database stays free of scaffolding. It also means reading it costs no connection to the
// template — which is exactly the thing a pending clone cannot tolerate.
async function storedFingerprint(name: string): Promise<string | null> {
  const admin = new Pool({ connectionString: ADMIN, max: 1 });
  try {
    const res = await admin.query(
      `select shobj_description(oid, 'pg_database') as hash from pg_database where datname = $1`,
      [name],
    );
    return res.rows[0]?.hash ?? null;
  } finally {
    await admin.end();
  }
}

// Build `kind`'s template database once, then leave it in place. Keeping it across runs is what
// makes a repeat `pnpm test` skip the bootstrap entirely; the fingerprint is what stops that
// from serving a stale schema.
// `from` layers this template on top of another one, so the web-with-data template only has to
// run the harbor recipe rather than the whole bootstrap a second time.
export async function ensureTemplate(
  kind: string,
  build: (appUrl: string) => Promise<void>,
  opts: { from?: string } = {},
): Promise<boolean> {
  const name = templateName(kind);
  const fp = fingerprint();

  if (process.env.WAREHOUSD_TEST_REBUILD_TEMPLATES !== "1" && (await storedFingerprint(name)) === fp) {
    return false;
  }

  await withTemplateLock(async (client) => {
    await client.query(`drop database if exists ${name} with (force)`);
    await client.query(
      opts.from ? `create database ${name} template ${templateName(opts.from)}` : `create database ${name}`,
    );
  });

  await build(`${BASE}/${name}`);

  // Stamped last, so a build that dies halfway leaves an uncommented — and therefore stale —
  // template rather than a plausible-looking broken one. COMMENT takes no bind parameters; the
  // fingerprint is a sha256 hex digest, so interpolating it is safe.
  const admin = new Pool({ connectionString: ADMIN, max: 1 });
  try {
    await admin.query(`comment on database ${name} is '${fp}'`);
  } finally {
    await admin.end();
  }
  return true;
}

export async function cloneTemplate(kind: string, dbName: string): Promise<void> {
  const template = templateName(kind);
  for (let attempt = 0; ; attempt++) {
    try {
      await withTemplateLock(async (client) => {
        await client.query(`drop database if exists ${dbName} with (force)`);
        await client.query(`create database ${dbName} template ${template}`);
      });
      return;
    } catch (err) {
      // A pool elsewhere can still be draining its last connection to the template when the
      // lock changes hands; Postgres reports that as "being accessed by other users".
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 4 || !msg.includes("being accessed by other users")) throw err;
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }
}
