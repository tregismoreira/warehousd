import type { Queryable } from "./queryable";

// The extensions whose objects this codebase names UNQUALIFIED, and therefore the ones whose
// schema has to be reachable from a role's search_path:
//
//   hmac()                        sql/mask.ts        `mask: { transform: hash }`, at request time
//   vector(n), vector_cosine_ops  apply/ddl.ts       the file-collection documents table
//   <=>, ::vector                 sql/build.ts       semantic search, at request time
//
// On a local Postgres `create extension` puts all of them in `public`, which every role already
// has on its search_path, so none of this ever mattered. A hosted Postgres is different: Supabase
// ships pgcrypto preinstalled in a schema called `extensions`, so `create extension if not exists
// pgcrypto` is a silent no-op and hmac() resolves for nobody. The failure mode is the bad one —
// apply succeeds, boot succeeds, and the first masked read fails at request time.
const EXTENSIONS = ["vector", "pgcrypto", "postgres_fdw"] as const;

// Names read back out of the catalogue, not names that came from validated config — so they are
// QUOTED rather than validated. `ident()` in sql/ident.ts is the other rule and the right one for
// its own callers: everything it sees is a literal in the source or a config-checked name, and
// rejecting anything else is the point. A schema someone else's provider created is neither, and
// refusing to apply because it is spelled `Extensions` would be this function inventing a rule.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Make the extension schemas reachable from every role that reads through them.
 *
 * Two things are needed, and the search_path alone is not enough: resolving `hmac` through
 * `search_path = public, extensions` still fails with "function hmac does not exist" unless the
 * role also holds USAGE on `extensions`, because a schema the role cannot use is a schema whose
 * contents it cannot see. Both are applied here.
 *
 * The settings are scoped `in database` deliberately. Roles are cluster-global — the whole reason
 * `withRoleRetry` in bootstrap.ts exists — so a plain `alter role … set` would reach into every
 * other database on the server, including a sibling checkout's live test databases.
 *
 * Takes a `Queryable` rather than a `Pool` on purpose: `applyConfig` calls this with the single
 * client it holds for the whole apply, which is what makes the session `set` at the bottom cover
 * the DDL that follows it.
 *
 * Returns the search_path that was set, or null when every extension is already in `public` and
 * there is nothing to do — which is the local-container case, left completely untouched.
 */
export async function ensureExtensionSearchPath(db: Queryable): Promise<string | null> {
  const found = await db.query<{ nspname: string }>(
    `select distinct n.nspname
       from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = any($1::text[]) and n.nspname <> 'public'
      order by 1`,
    [[...EXTENSIONS]],
  );
  const schemas = found.rows.map((r) => r.nspname);
  if (schemas.length === 0) return null;

  const path = ["public", ...schemas].map(quoteIdent).join(", ");

  // Discovered rather than listed: `warehousd_import` is created outside ensureSchemasAndRoles,
  // and a role added later would otherwise be the one role that quietly keeps the old path.
  const roles = (
    await db.query<{ rolname: string }>(
      `select rolname from pg_roles where rolname like 'warehousd\\_%' order by 1`,
    )
  ).rows.map((r) => r.rolname);

  for (const schema of schemas) {
    // Only grant what is actually missing. A provider that already granted USAGE to everything
    // needs nothing from us, and on a deployment where the connect-as role does not own the
    // schema — Supabase's `extensions` belongs to `postgres`, but not every provider's does —
    // an unconditional grant would turn a working stack into a failed apply.
    const missing: string[] = [];
    for (const role of roles) {
      const r = await db.query<{ has: boolean }>(
        `select has_schema_privilege($1, $2, 'usage') as has`,
        [role, schema],
      );
      if (!r.rows[0]?.has) missing.push(role);
    }
    if (missing.length === 0) continue;
    try {
      await db.query(
        `grant usage on schema ${quoteIdent(schema)} to ${missing.map(quoteIdent).join(", ")}`,
      );
    } catch (err) {
      // Not swallowed: without this grant a masked read and a semantic search both fail at
      // request time, as `internal_error`, a long way from anything that names the cause.
      throw new Error(
        `Cannot grant usage on schema "${schema}" to ${missing.join(", ")}, and without it ` +
          `those roles cannot resolve the ${EXTENSIONS.join("/")} objects installed there. ` +
          `Connect as a role that owns "${schema}", or grant it by hand and re-apply.`,
        { cause: err },
      );
    }
  }

  const dbName = (await db.query<{ name: string }>(`select current_database() as name`)).rows[0]!
    .name;
  for (const role of roles) {
    await db.query(
      `alter role ${quoteIdent(role)} in database ${quoteIdent(dbName)} set search_path = ${path}`,
    );
  }
  // The role holding this connection — whatever it is called on this provider — needs it too:
  // tableDDL below spells the pgvector column `vector(n)`. `current_user` rather than a name we
  // look up, because a role may always set its own defaults, no ownership required.
  await db.query(
    `alter role current_user in database ${quoteIdent(dbName)} set search_path = ${path}`,
  );
  // A role setting lands at connection start, and this connection started before it existed. The
  // DDL that needs it runs next, on this same connection — see applyConfig — so it is set here
  // too; the `alter role` above is what carries it to every connection made after this one.
  await db.query(`set search_path = ${path}`);

  return path;
}
