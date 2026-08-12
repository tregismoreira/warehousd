import type { Pool } from "pg";
import { kindOf } from "../config/kinds";
import type { WarehousdConfig } from "../config/schema";
import {
  tableDDL,
  foreignTableDDL,
  viewDDL,
  grantViewDDL,
  grantImportDDL,
  rlsDDL,
  grantWriteDDL,
  aclTableDDL,
  grantAclWriteDDL,
  DEFAULT_EMBEDDING_DIMENSIONS,
} from "./ddl";
import { planFromSchema, type SchemaChange } from "./plan";
import { ensureExtensionSearchPath } from "../db/search-path";
import type { Queryable } from "../db/queryable";

// A file collection's documents hang off its files table by FK, and are rebuilt by the indexer
// from the same source directory, so the two are always dropped as a pair.
function tablesToDrop(table: string): string[] {
  return table.endsWith("__files") ? [table, table.replace(/__files$/, "__documents")] : [table];
}

/**
 * Refuse the changes that would strand or destroy live content, and rebuild the ones that cannot.
 *
 * The asymmetry between the two schemas is the whole design. `data_synth` is a pure function of
 * (config, seed): the entrypoint truncates and regenerates it on every boot, and file collections
 * are re-indexed from their source directory. Dropping a synth table therefore costs nothing, and
 * paying migration ceremony for it would put friction on the one loop — edit the YAML, re-apply —
 * that has to stay fast. `data_live` is real content that exists nowhere else.
 *
 * An empty `data_live` table is treated like a synth one, because there is nothing there to lose.
 *
 * Throws one error listing every blocked change rather than one per change: an operator editing
 * their config should see the whole bill, not discover it a field at a time across six deploys.
 */
async function resolveDestructiveChanges(db: Queryable, cfg: WarehousdConfig): Promise<void> {
  const changes = (await planFromSchema(db, cfg)).filter((c) => c.destructive);
  if (changes.length === 0) return;

  const blocked: SchemaChange[] = [];
  const drop = new Set<string>();

  for (const change of changes) {
    const schema = change.env === "dev" ? "data_synth" : "data_live";
    if (change.env === "live") {
      const populated = await db.query(`select 1 from ${schema}."${change.table}" limit 1`);
      if (populated.rowCount === 1) {
        blocked.push(change);
        continue;
      }
    }
    for (const t of tablesToDrop(change.table)) drop.add(`${schema}."${t}"`);
  }

  if (blocked.length > 0) {
    const lines = blocked.map((c) => `  - ${c.detail}`);
    // Every name in this message comes from the config or from information_schema, never from a
    // request, and it is written to the operator's boot log — no broker caller sees it. Invariant 4
    // is about what a denied *client* can observe, and nothing here is reachable by one.
    throw new Error(
      `Refusing to apply: ${blocked.length} change(s) would destroy or strand live data.\n` +
        `${lines.join("\n")}\n\n` +
        `data_live holds rows for these collections, and applyConfig will not rewrite a column ` +
        `underneath them. Run \`warehousd migrate generate\` to write a migration you can review, ` +
        `edit it, and re-apply. \`warehousd migrate plan\` explains each change and its options.`,
    );
  }

  // Dropped rather than altered: these tables are empty or disposable, so a rebuild is both
  // simpler and more complete than a column-by-column ALTER — it also fixes a pk that moved and a
  // column that changed in a way no cast covers. The views are recreated further down, and the
  // entrypoint regenerates synthetic rows and re-indexes file collections straight afterwards.
  for (const t of drop) await db.query(`drop table if exists ${t} cascade`);

  // A collection that left the YAML also leaves the registry, or the admin console goes on
  // listing something that no longer exists in either the config or the database.
  const gone = new Set(
    changes.filter((c) => c.kind === "drop_collection").map((c) => c.collection),
  );
  for (const name of gone) {
    await db.query(`delete from app.collections where name = $1`, [name]);
    // Its ACL rows too. `_acl` is one shared table keyed by (workspace, collection, document), so
    // dropping the collection's table does not take them with it — and a collection later
    // re-created under the same name would inherit restrictions nobody remembers setting.
    for (const schema of ["data_synth", "data_live"])
      await db.query(`delete from ${schema}."_acl" where collection = $1`, [name]);
  }
}

/**
 * The whole apply runs on ONE connection, checked out for the duration.
 *
 * Not a tidiness preference. `ensureExtensionSearchPath` sets a session `search_path` that the
 * DDL below depends on — `vector(n)` and `vector_cosine_ops` are unqualified — and a session
 * setting only holds for the connection that received it. Handed a `Pool`, every statement here
 * would pick whichever client happened to be idle; that reuses one client in practice for
 * sequential awaits, which is an implementation detail of `pg` and not something DDL correctness
 * should rest on. Checking one out makes it a fact instead.
 *
 * It also removes the interleaving question entirely: nothing else can run a statement between
 * `resolveDestructiveChanges` deciding a table is empty and the DDL that acts on that.
 */
export async function applyConfig(
  db: Pool,
  cfg: WarehousdConfig,
  opts: { onProgress?: (p: ApplyProgress) => void } = {},
): Promise<void> {
  const client = await db.connect();
  try {
    await applyOn(client, cfg, opts.onProgress);
  } finally {
    client.release();
  }
}

// Which collection an apply is on, in the shape EmbedProgress already had. `label` carries the
// collection name: an apply that hangs hangs on a specific table, and naming it is the difference
// between "still going" and "still going, on `matters`".
export type ApplyProgress = { done: number; total: number; label: string };

async function applyOn(
  db: Queryable,
  cfg: WarehousdConfig,
  onProgress?: (p: ApplyProgress) => void,
): Promise<void> {
  await db.query(`create extension if not exists vector`);
  // hmac(), for `mask: { transform: hash }`. Created unconditionally rather than only when some
  // collection declares that transform: a later `warehousd apply` adding one must not be the
  // first thing that needs a superuser, long after the deployment stopped having one.
  await db.query(`create extension if not exists pgcrypto`);
  // postgres_fdw, for `sources:` / `source_ref:`. Created only when the config declares one —
  // unlike vector and pgcrypto it is not needed by a default project, and a deployment whose
  // Postgres forbids it should not fail to boot over a feature it does not use.
  if (Object.keys(cfg.sources ?? {}).length > 0)
    await db.query(`create extension if not exists postgres_fdw`);

  // Immediately after the three above, because it reads back where they actually landed. A
  // hosted Postgres that ships one of them preinstalled outside `public` makes the
  // `if not exists` a no-op and leaves every unqualified reference to it unresolvable — see
  // db/search-path.ts. Here rather than in ensureSchemasAndRoles because the extensions do not
  // exist yet at that point, and here rather than in the entrypoint because `warehousd apply`
  // has to stay correct on a re-run too.
  await ensureExtensionSearchPath(db);

  // The shared per-document ACL table, before everything else. Two things need it early: a
  // collection with `acl: true` joins it, so `create view` fails outright if it is not there yet,
  // and resolveDestructiveChanges deletes a dropped collection's ACL rows.
  //
  // Created unconditionally rather than only when some collection asks for ACLs — like the vector
  // and pgcrypto extensions above, a later `warehousd apply` that turns one on must not be the
  // first thing that needs new DDL.
  for (const env of ["dev", "live"] as const) await db.query(aclTableDDL(env));

  // Before any DDL: nothing below this line can alter or drop a column, so a change that needs one
  // has to be settled here or refused here.
  await resolveDestructiveChanges(db, cfg);

  // Vocabularies: upsert by slug (labels renameable in place). apply never deletes
  // vocabularies/terms — data rows store term slugs, so removal is a manual operation.
  for (const [slug, v] of Object.entries(cfg.taxonomies ?? {})) {
    const vid = (
      await db.query(
        `insert into app.vocabularies (slug, label) values ($1,$2)
       on conflict (slug) do update set label=excluded.label returning id`,
        [slug, v.label],
      )
    ).rows[0].id;
    // Insert YAML-sourced terms with env='all'. workspace_id='*': declared in warehousd.yml,
    // therefore deployment-global — every workspace sees the same config-declared terms, unlike
    // a dataset-sourced vocabulary's terms, which syncDatasetTerms derives per workspace.
    if (v.terms) {
      for (const [t, tv] of Object.entries(v.terms))
        await db.query(
          `insert into app.terms (vocabulary_id, env, workspace_id, slug, label) values ($1,$2,'*',$3,$4)
           on conflict (vocabulary_id, env, workspace_id, slug) do update set label=excluded.label`,
          [vid, "all", t, tv.label],
        );
    }
    // Dataset-sourced vocabularies: terms are synced by syncDatasetTerms, not here
  }

  // Two passes over the collections — tables, then views — so the count runs 0..n twice. Reported
  // with a phase in the label rather than as two totals, which would look like a reset.
  const names = Object.keys(cfg.collections);
  for (const [i, name] of names.entries()) {
    onProgress?.({ done: i, total: names.length, label: `tables · ${name}` });
    const c = cfg.collections[name];
    if (!c) throw new Error(`Unknown collection: ${name}`);

    // A changed embedding dimension means a changed model, and pgvector cannot widen a column
    // in place. The stored vectors are derived data — re-derivable by `warehousd embed` — so the
    // column is dropped and recreated rather than the apply refusing. Detected via atttypmod,
    // which is where pgvector keeps the width.
    if (kindOf(c).chunked) {
      const want = cfg.embedding?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
      for (const env of ["dev", "live"] as const) {
        const schema = env === "dev" ? "data_synth" : "data_live";
        const cur = await db.query<{ atttypmod: number }>(
          `select a.atttypmod from pg_attribute a
             join pg_class t on t.oid = a.attrelid
             join pg_namespace n on n.oid = t.relnamespace
           where n.nspname = $1 and t.relname = $2 and a.attname = 'embedding' and a.attnum > 0`,
          [schema, `${name}__documents`],
        );
        const have = cur.rows[0]?.atttypmod;
        if (have !== undefined && have > 0 && have !== want) {
          await db.query(`alter table ${schema}."${name}__documents" drop column embedding`);
        }
      }
    }

    // Migration detection: every dataset is revisioned now, so a pre-existing table WITHOUT
    // _rev* columns cannot be brought forward by `create table if not exists` — the alters
    // below would add the data columns and leave the NOT NULL bookkeeping ones missing, and
    // the first insert would fail a long way from the cause. The _rev* columns are the marker.
    // Migrating existing rows into revisions is explicitly out of scope: fail loudly here.
    if (c.type === "dataset") {
      for (const env of ["dev", "live"] as const) {
        const schema = env === "dev" ? "data_synth" : "data_live";
        const check = await db.query(
          `select 1 from information_schema.tables where table_schema=$1 and table_name=$2`,
          [schema, name],
        );
        if (check.rowCount === 1) {
          const hasRev = await db.query(
            `select 1 from information_schema.columns where table_schema=$1 and table_name=$2 and column_name='_rev'`,
            [schema, name],
          );
          if (hasRev.rowCount === 0) {
            throw new Error(
              `Cannot apply ${name} — the table in ${schema} already exists without revision ` +
                `columns. Every dataset is revisioned; migrating existing data into revisions is ` +
                `out of scope. Drop the table manually or use a different collection name.`,
            );
          }
        }
      }
    }

    for (const env of ["dev", "live"] as const) {
      const ddl = tableDDL(env, name, cfg);
      if (ddl.trim()) await db.query(ddl);
    }
    // The foreign table replaces the live base table for an external collection, so it has to
    // exist before the views below are built over it.
    if (c.source_ref) {
      await db.query(foreignTableDDL(name, cfg));
      await verifyExternalShape(db, name, cfg);
    }
  }
  // views after all tables (joins reference sibling tables)
  // A stack provisioned before the import role existed still applies cleanly.
  const hasImportRole =
    (await db.query(`select 1 from pg_roles where rolname='warehousd_import'`)).rowCount === 1;
  const hasWriteRoles =
    (await db.query(`select 1 from pg_roles where rolname='warehousd_live_write'`)).rowCount === 1;

  // Once per env, not once per collection: `_acl` is one table shared by all of them.
  if (hasWriteRoles)
    for (const env of ["dev", "live"] as const) await db.query(grantAclWriteDDL(env));

  for (const [i, name] of names.entries()) {
    onProgress?.({ done: i, total: names.length, label: `views · ${name}` });
    for (const env of ["dev", "live"] as const) {
      await db.query(viewDDL(env, name, cfg));
      await db.query(grantViewDDL(env, name));
      const rls = rlsDDL(env, name, cfg);
      if (rls.trim()) await db.query(rls);
    }
    const importGrant = grantImportDDL(name, cfg);
    if (hasImportRole && importGrant) await db.query(importGrant);

    if (hasWriteRoles) {
      for (const env of ["dev", "live"] as const) {
        const writeGrant = grantWriteDDL(env, name, cfg);
        if (writeGrant) await db.query(writeGrant);
      }
    }

    const c = cfg.collections[name];
    if (!c) throw new Error(`Unknown collection: ${name}`);
    await db.query(
      `insert into app.collections (name, description, config, updated_at)
       values ($1,$2,$3, now())
       on conflict (name) do update set description=excluded.description,
         config=excluded.config, updated_at=now()`,
      [name, c.description, JSON.stringify(c)],
    );
  }
  onProgress?.({ done: names.length, total: names.length, label: "done" });
}

/**
 * Check that the remote table actually looks like the YAML says it does.
 *
 * Without this, a column renamed or retyped upstream surfaces at REQUEST time, as a driver error
 * the broker has to swallow as `internal_error` — a governed query failing for a reason nobody
 * can see. Here it fails at apply time, naming the collection, the field and what the remote
 * actually has, in front of the operator who can fix it.
 *
 * The check is a real query against the foreign table with `limit 0`: it costs one round trip,
 * needs no extra privilege, and proves the exact thing that matters — that every declared column
 * can be selected at its declared type — rather than approximating it from catalogue metadata.
 */
async function verifyExternalShape(
  db: Queryable,
  collection: string,
  cfg: WarehousdConfig,
): Promise<void> {
  const c = cfg.collections[collection];
  if (!c?.source_ref) return;
  const cols = Object.entries(c.fields)
    .filter(([, f]) => !f.view_join)
    .map(([name]) => `"${name}"`);
  try {
    await db.query(`select ${cols.join(", ")} from data_live."_ext_${collection}" limit 0`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Every name here comes from the config or from Postgres's own reply about a table the
    // operator configured, and it is written to the boot log. No broker caller reaches it.
    //
    // A connection failure and a shape mismatch get different messages because they have
    // different fixes, and telling someone to check their column names when the real problem is
    // that Postgres cannot reach the host sends them a long way in the wrong direction.
    if (/could not connect|password|authentication|no pg_hba|timeout/i.test(detail))
      throw new Error(
        `Source "${c.source_ref.source}" is unreachable: ${detail}\n` +
          `The connection is made by POSTGRES, not by warehousd, so \`sources.${c.source_ref.source}.url\` ` +
          `must name a host and port the database server itself can reach — which is not always ` +
          `the one your client uses (a containerised Postgres cannot reach its own published ` +
          `host port).`,
        { cause: err },
      );
    throw new Error(
      `Collection "${collection}" does not match its source (${c.source_ref.source}.${c.source_ref.table}): ${detail}\n` +
        `Declare the columns as they exist upstream, or use \`column:\` to map a differing name.`,
      { cause: err },
    );
  }
}
