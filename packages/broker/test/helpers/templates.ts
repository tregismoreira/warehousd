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
export const SUFFIX = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);

export function templateName(kind: string): string {
  return `wh_tmpl_${kind}_${SUFFIX}`;
}

// Postgres truncates identifiers at 63 bytes, silently. Two clone names that differ only past
// byte 63 become the same database, so a suite would run against another suite's data instead of
// failing — assert rather than assume, as the plan's 5.4.1 asks.
const MAX_IDENT = 63;

// Every per-run clone goes through here, and the suffix in the middle is what makes the sweeps in
// vitest.global-setup.ts addressable to *this* checkout.
//
// Before this, clone names were `wh_<label>_<pid>` with no suffix, so the only sweep that could
// have collected them — "drop every wh_% that is not a template" — would also have dropped a
// sibling checkout's in-flight test databases. That is the exact failure the SUFFIX comment above
// exists to prevent, which is why the leak went uncollected: 211 abandoned clones holding 1.68 GB,
// with idle autovacuum on them costing ~27% CPU.
export function cloneName(prefix: string, label: string): string {
  const name = `${prefix}_${label}_${SUFFIX}_${process.pid}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  if (Buffer.byteLength(name) > MAX_IDENT) {
    throw new Error(
      `test database name "${name}" is ${Buffer.byteLength(name)} bytes; Postgres truncates at ` +
        `${MAX_IDENT} and two truncated-equal names are the same database. Shorten the label.`,
    );
  }
  return name;
}

// `wh_%_<SUFFIX>_%` — every clone this checkout makes, and nothing another checkout made. The
// templates are `wh_tmpl_<kind>_<SUFFIX>` with nothing after the suffix, so they do not match; they
// are also excluded by name below, because losing one to a pattern change would mean a silent
// full rebuild rather than an error.
export function cloneLikePattern(): string {
  return `wh\\_%\\_${SUFFIX}\\_%`;
}

// The suffix scopes a sweep to this checkout, but not to this *process*: `pnpm test` is two vitest
// passes and nothing stops a second one (`pnpm test:e2e:sso`, a single-file run) from overlapping
// with the first. A sweep that ignored that would drop the other run's in-flight databases, which
// is the same failure as dropping a sibling checkout's, just harder to see.
//
// The trailing pid is what settles it. Names are `…_<SUFFIX>_<pid>` where pid is the vitest worker
// fork that provisioned the database, so a live pid means a live run. Pid reuse can make a dead
// clone look alive; it is then collected on a later sweep, which is the safe direction to be wrong.
function ownerAlive(datname: string): boolean {
  const pid = Number(datname.slice(datname.lastIndexOf("_") + 1));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Drop this checkout's leftover per-run clones.
//
// Called from both `setup()` and `teardown()` in vitest.global-setup.ts. Teardown covers the
// ordinary case, including a suite whose `afterAll` never ran because a hook threw. Setup is the
// only thing that can collect a run that was *killed* — Ctrl-C, an OOM, a killed worker — and it
// is what makes the leak self-healing instead of dependent on someone remembering a command.
export async function dropStaleClones(): Promise<number> {
  const keep = ["broker", "web", "web_data"].map(templateName);
  const admin = new Pool({ connectionString: ADMIN, max: 1 });
  try {
    const r = await admin.query<{ datname: string }>(
      `select datname from pg_database
        where datname like $1 escape '\\' and datname <> all($2::text[])`,
      [cloneLikePattern(), keep],
    );
    let dropped = 0;
    for (const { datname } of r.rows) {
      if (ownerAlive(datname)) continue;
      // The name came from pg_database and matched the pattern above, so it is a plain identifier;
      // `drop database` takes no bind parameters.
      await admin.query(`drop database if exists ${datname} with (force)`);
      dropped++;
    }
    return dropped;
  } finally {
    await admin.end();
  }
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
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
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
// Any session still attached to a template blocks `create database ... template`. The templates
// belong to the harness alone, so such a session is always a leftover rather than someone's real
// work — building the web template imports lib/auth, and that module opens a pool at load which
// nothing ever closes. Evict them inside the lock instead of waiting for them to drain.
async function createFromTemplate(client: PoolClient, name: string, template: string) {
  await client.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = $1 and pid <> pg_backend_pid()`,
    [template],
  );
  await client.query(`create database ${name} template ${template}`);
}

// `from` layers this template on top of another one, so the web-with-data template only has to
// run the harbor recipe rather than the whole bootstrap a second time.
export async function ensureTemplate(
  kind: string,
  build: (appUrl: string) => Promise<void>,
  opts: { from?: string } = {},
): Promise<boolean> {
  const name = templateName(kind);
  const fp = fingerprint();

  if (
    process.env.WAREHOUSD_TEST_REBUILD_TEMPLATES !== "1" &&
    (await storedFingerprint(name)) === fp
  ) {
    return false;
  }

  await withTemplateLock(async (client) => {
    await client.query(`drop database if exists ${name} with (force)`);
    if (opts.from) await createFromTemplate(client, name, templateName(opts.from));
    else await client.query(`create database ${name}`);
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
        await createFromTemplate(client, dbName, template);
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
