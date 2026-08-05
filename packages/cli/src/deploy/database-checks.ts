import { Pool } from "pg";
import { resolveProvider, UNQUALIFIED_EXTENSIONS, type DbProviderId } from "@warehousd/broker";
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

type Row = Record<string, unknown>;

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
async function canCreateRoleCheck(db: Pool): Promise<PreflightCheck> {
  const id = "db-can-create-role";
  try {
    const res = await db.query<{ ok: boolean; who: string }>(
      `select (rolcreaterole or rolsuper) as ok, rolname as who
         from pg_roles where rolname = current_user`,
    );
    const row = res.rows[0];
    if (!row) return { id, ok: false, detail: "current_user is not in pg_roles" };
    return row.ok
      ? { id, ok: true, detail: `${row.who} may create roles` }
      : {
          id,
          ok: false,
          detail:
            `${row.who} has neither CREATEROLE nor SUPERUSER, and boot creates the four ` +
            `warehousd_* roles. Connect as the project's owner role.`,
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
 * Will `ensureExtensionSearchPath` (broker db/search-path.ts) be able to do its job here?
 *
 * It grants USAGE on each extension schema to the warehousd roles, then puts that schema on their
 * search_path. Two ways that is already fine: the roles hold the privilege (a provider that grants
 * it to everyone), or we own the schema and can grant it. Neither, and the apply throws — which is
 * the right thing for it to do, but a much more expensive place to find out.
 */
async function searchPathCheck(db: Pool): Promise<PreflightCheck> {
  const id = "db-search-path";
  try {
    const res = await db.query<Row>(
      `select n.nspname                                     as schema,
              string_agg(e.extname, ', ' order by e.extname) as exts,
              pg_has_role(current_user, n.nspowner, 'USAGE') as can_grant,
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

    const blocked = res.rows.filter((r) => Number(r.lacking) > 0 && r.can_grant !== true);
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

function detailOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0] ?? msg;
}
