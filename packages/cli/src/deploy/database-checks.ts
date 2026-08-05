import { Pool } from "pg";
import {
  dbProviders,
  detectProvider,
  resolveProvider,
  UNQUALIFIED_EXTENSIONS,
  type DbProviderId,
} from "@warehousd/broker";
import { hostOf } from "../preflight";
import type { PreflightCheck } from "./preflight";

// The same budget the SSO lookup uses (deploy.ts). A pre-flight is a question asked from an
// operator's laptop about a database on the other side of the internet; a slow answer is still an
// answer, but an unbounded wait is a hung command.
const DB_CHECK_TIMEOUT_MS = 5000;

// vector and pgcrypto are created unconditionally by applyConfig; postgres_fdw only when the
// config declares a source, because neither Supabase nor Neon allows it and a deployment that
// uses no external source must not be refused over a feature it does not want. This mirrors
// apply.ts — if that condition changes, this one has to change with it.
const ALWAYS_REQUIRED = ["vector", "pgcrypto"] as const;

/** One row of a catalogue query, read by name rather than narrowed — pg types nothing for us. */
export type Row = Record<string, unknown>;

/**
 * Can this database do what a warehousd deployment needs, asked before an image is pushed.
 *
 * Every failure here is one that would otherwise surface at the release command or, worse, at the
 * first masked read — a long way from anything that names the cause. The checks are deliberately
 * read-only: they ask the catalogue what is possible, they never create a role or an extension to
 * find out.
 *
 * A database that cannot be reached is a refusal that says the lookup failed, never a silent pass
 * (the same rule ssoOrLocalLoginCheck follows). The provider's own checks still run in that case,
 * because "you pointed at the transaction pooler" is a finding that does not need a connection —
 * and is a plausible reason the connection behaved oddly in the first place.
 */
export async function databaseCapabilities(
  url: string,
  opts: { requireFdw: boolean; provider?: DbProviderId | undefined },
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const db = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: DB_CHECK_TIMEOUT_MS,
    statement_timeout: DB_CHECK_TIMEOUT_MS,
  });

  let reachable = false;
  try {
    await db.query("select 1");
    reachable = true;
    checks.push({
      id: "db-reachable",
      ok: true,
      // The host, never the url: a connection string carries a password and this line is printed
      // to a terminal and pasted into issues.
      detail: `connected to ${hostOf(url)}`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      id: "db-reachable",
      ok: false,
      detail: `${hostOf(url)}: ${msg.split("\n")[0] ?? msg}`,
    });
  }

  if (reachable) {
    checks.push(await canCreateRoleCheck(db));
    checks.push(await extensionsCheck(db, opts.requireFdw));
    checks.push(await searchPathCheck(db));
  } else {
    for (const id of ["db-can-create-role", "db-extensions", "db-search-path"]) {
      checks.push({ id, ok: false, detail: "not evaluated: could not connect to the database" });
    }
  }

  checks.push(...(await providerChecks(url, opts.provider, reachable ? db : null)));

  await db.end().catch(() => {});
  return checks;
}

// ensureSchemasAndRoles creates four roles and rotates their passwords on every boot. A connect-as
// role that cannot do that produces a deployment that fails at the release command, after the
// image is built and pushed.
//
// The question is asked about *inherited* privilege, not about the role's own attributes. Every
// hosted provider this feature exists for hands CREATEROLE out through a grantor role rather than
// setting it on the project owner: Neon's `neondb_owner` gets it through `neon_superuser`, RDS
// through `rds_superuser`. Reading `pg_roles` for `current_user` alone refused all of them.
//
// The caveat, stated rather than hidden: stock Postgres does not confer CREATEROLE through
// membership — role attributes are not inherited — so on a vanilla server this can pass for a role
// that would still fail at boot. That is the safe direction to be wrong. The providers that matter
// patch exactly this, the check errs toward not blocking, and the release command still catches
// the genuine failure; refusing every Neon deployment does not.
//
// `'usage'` rather than `'member'`: only an inheritable membership confers anything without a
// `set role`, and boot issues none.
async function canCreateRoleCheck(db: Pool): Promise<PreflightCheck> {
  const id = "db-can-create-role";
  try {
    // An aggregate with no GROUP BY, so there is always exactly one row — `ok` is null rather
    // than the row being absent when nothing matched, and null reads as "no" below.
    const res = await db.query<{ ok: boolean | null; who: string }>(
      `select bool_or(r.rolcreaterole or r.rolsuper) as ok, current_user as who
         from pg_roles r
        where pg_has_role(current_user, r.oid, 'usage')`,
    );
    const row = res.rows[0];
    if (!row) return { id, ok: false, detail: "could not read current_user's role memberships" };
    return row.ok
      ? { id, ok: true, detail: `${row.who} may create roles` }
      : {
          id,
          ok: false,
          detail:
            `${row.who} has neither CREATEROLE nor SUPERUSER, neither directly nor through any ` +
            `role it is a member of, and boot creates the four warehousd_* roles. Connect as the ` +
            `project's owner role.`,
        };
  } catch (err: unknown) {
    return { id, ok: false, detail: detailOf(err) };
  }
}

async function extensionsCheck(db: Pool, requireFdw: boolean): Promise<PreflightCheck> {
  const id = "db-extensions";
  const wanted = [...ALWAYS_REQUIRED, ...(requireFdw ? (["postgres_fdw"] as const) : [])];
  try {
    const res = await db.query<{ name: string }>(
      `select name from pg_available_extensions where name = any($1::text[])`,
      [wanted],
    );
    const have = new Set(res.rows.map((r) => r.name));
    const missing = wanted.filter((n) => !have.has(n));
    if (missing.length === 0)
      return { id, ok: true, detail: `${wanted.join(", ")} available on this server` };
    return {
      id,
      ok: false,
      detail:
        `not available on this server: ${missing.join(", ")}. ` +
        (missing.includes("postgres_fdw")
          ? "postgres_fdw is needed because warehousd.yml declares a `sources:` entry; " +
            "hosted Postgres providers generally forbid it."
          : "warehousd cannot apply without them."),
    };
  } catch (err: unknown) {
    return { id, ok: false, detail: detailOf(err) };
  }
}

/**
 * Is this extension schema out of reach for the roles boot will create?
 *
 * Decided on capability, not on the roles that happen to exist right now. `lacking` counts the
 * `warehousd_*` roles that do not hold usage — and on a database that has never booted there are
 * none, which made it 0 for every schema and the whole check a pass that had verified nothing, on
 * precisely the run where the answer matters. After the first boot `ensureExtensionSearchPath` has
 * already done the work, so that is the run where it is least needed.
 *
 * Two ways the schema is fine regardless of who holds what today: this role owns it and can grant
 * usage, or `PUBLIC` already holds usage — which a role created later inherits. Failing both, a
 * cluster with no warehousd roles yet is unproven rather than proven, and `role_count = 0` is what
 * says so.
 *
 * Exported because that first-deploy branch cannot be reached from a test: `pg_roles` is
 * cluster-global and this repo's suites share one Postgres, so `warehousd_*` roles always exist by
 * the time anything runs (AGENTS.md, "Machine load").
 */
export function searchPathBlocked(r: Row): boolean {
  if (r.can_grant === true || r.public_usage === true) return false;
  return Number(r.role_count) === 0 || Number(r.lacking) > 0;
}

/**
 * Will `ensureExtensionSearchPath` (broker db/search-path.ts) be able to do its job here?
 *
 * It grants USAGE on each extension schema to the warehousd roles, then puts that schema on their
 * search_path. Neither of `searchPathBlocked`'s two escapes, and the apply throws — which is the
 * right thing for it to do, but a much more expensive place to find out.
 */
async function searchPathCheck(db: Pool): Promise<PreflightCheck> {
  const id = "db-search-path";
  try {
    const res = await db.query<Row>(
      `select n.nspname                                     as schema,
              string_agg(e.extname, ', ' order by e.extname) as exts,
              pg_has_role(current_user, n.nspowner, 'USAGE') as can_grant,
              has_schema_privilege('public', n.nspname, 'usage') as public_usage,
              (select count(*) from pg_roles where rolname like 'warehousd\\_%') as role_count,
              (select count(*) from pg_roles r
                where r.rolname like 'warehousd\\_%'
                  and not has_schema_privilege(r.rolname, n.nspname, 'usage')) as lacking
         from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where e.extname = any($1::text[]) and n.nspname <> 'public'
        group by n.nspname, n.nspowner
        order by 1`,
      [[...UNQUALIFIED_EXTENSIONS]],
    );
    if (res.rows.length === 0)
      return {
        id,
        ok: true,
        detail: "every installed extension is in `public`, which every role already reaches",
      };

    const blocked = res.rows.filter(searchPathBlocked);
    const described = res.rows.map((r) => `${String(r.exts)} in "${String(r.schema)}"`).join("; ");
    if (blocked.length === 0)
      return { id, ok: true, detail: `${described} — reachable, or grantable by this role` };

    return {
      id,
      ok: false,
      detail:
        `${described}. This role neither owns ${blocked
          .map((r) => `"${String(r.schema)}"`)
          .join(", ")} nor finds usage already granted on it, so the warehousd roles cannot ` +
        `resolve hmac()/vector()/<=> through it. Grant usage by hand, or connect as the owner.`,
    };
  } catch (err: unknown) {
    return { id, ok: false, detail: detailOf(err) };
  }
}

// The `db-provider` line always appears, even for a provider with nothing to say: which provider
// was picked is itself the answer to "why is my role spelled like that", and a mis-detection is
// otherwise invisible.
async function providerChecks(
  url: string,
  id: DbProviderId | undefined,
  db: Pool | null,
): Promise<PreflightCheck[]> {
  const mismatch = providerMismatch(url, id);
  if (mismatch) return [mismatch];

  const provider = resolveProvider(url, id);
  if (!provider.checks) {
    return [
      { id: "db-provider", ok: true, detail: `${provider.label}: nothing provider-specific` },
    ];
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [
      {
        id: "db-provider",
        ok: true,
        detail: `${provider.label}: not evaluated, the url is not a postgres:// URL`,
      },
    ];
  }
  return provider.checks(parsed, db);
}

/**
 * A configured `provider` that contradicts the host it is set on.
 *
 * `resolveProvider` takes the configured id verbatim, which is what the key is for — but nothing
 * checked it against the url, so `provider: supabase` on a `*.neon.tech` host derived
 * `warehousd_dev.<something>` and authenticated as nobody. That is the exact failure the key
 * exists to prevent (docs/deploy-database.md, "The provider key"), and it is not a parse error:
 * without this, the first sign of it is a role that cannot log in.
 *
 * A configured id over a host nothing recognises stays valid. That is the CNAME-onto-your-own-
 * domain case the key was added for, and it is the only case where the operator knows more than
 * the hostname does.
 */
function providerMismatch(url: string, id: DbProviderId | undefined): PreflightCheck | null {
  if (id === undefined) return null;
  const detected = detectProvider(url);
  if (detected.id === "generic" || detected.id === id) return null;

  const configured = dbProviders[id];
  return {
    id: "db-provider",
    ok: false,
    detail:
      `warehousd.yml says provider: ${id} (${configured.label}), but ${hostOf(url)} is a ` +
      `${detected.label} host. Role names are derived per provider, so the wrong one produces a ` +
      `role that cannot authenticate. Set provider: ${detected.id}, or drop the key and let the ` +
      `host decide.`,
  };
}

function detailOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0] ?? msg;
}
