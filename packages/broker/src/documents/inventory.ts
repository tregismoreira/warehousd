import type { WarehousdConfig } from "../config/schema";
import { kindOf } from "../config/kinds";
import { findCollection } from "../config/load";
import { dataSchema } from "../config/collection";
import { ident } from "../sql/ident";
import { dataPool, type Pools, withOrg } from "../db/pools";

// Inventory: how much is in a collection, which files back it, how its terms are distributed.
//
// The console needs these numbers to say anything about *state* rather than configuration, and
// invariant 1 says a route may not reach a data schema to get them. So they live here, beside
// documents/paths.ts, and follow the same three rules: read through the env-scoped pool inside
// withOrg, validate the collection against the loaded config before its name is interpolated,
// and hand back plain values that a caller shapes into a response.
//
// None of this is grant-checked, and deliberately so — it is inventory metadata for an admin
// surface, the same standing listDocumentPaths has. What is *not* here is field values: the only
// column read is one the config declares as a vocabulary, and the only aggregate is a count.
// Anything that would return a document goes through broker.query, which is grant-checked.

/** Which environment's data, and whose. Neither is ever read from a request. */
export type Scope = { env: "dev" | "live"; orgId: string };

/**
 * One indexed source file, with the number of documents it was chunked into.
 *
 * Every posture-carrying field is present. The caller decides which of them survive into a
 * response — `path` is commonly `posture: deny` (it gates documents without being readable),
 * so a route that returns it unconditionally would breach invariant 4.
 */
export type FileSummary = {
  id: string;
  title: string | null;
  path: string;
  owner: string | null;
  updated_at: string;
  checksum: string;
  documentCount: number;
};

function viewOf(cfg: WarehousdConfig, env: "dev" | "live", collection: string): string {
  if (!findCollection(cfg, collection)) throw new Error(`Unknown collection: ${collection}`);
  // Validated against the loaded config above, then quoted anyway: this is the point of
  // interpolation, and it is the point that checks rather than the one that assumes.
  return `${dataSchema(env)}.${ident(`v_${collection}`)}`;
}

/**
 * How many documents the collection holds in this environment.
 *
 * A file collection's view yields one row per chunk, which is what this codebase calls a
 * document everywhere else (searchDocuments returns them, `{c}__documents` stores them). So
 * one count answers for both collection types without a branch.
 *
 * A collection that has never been applied to this environment has no view and counts 0 —
 * which is true, and is why callers that want to say "not applied" rather than "empty" check
 * the apply status themselves instead of reading it out of a number.
 */
export async function countDocuments(
  pools: Pools,
  scope: Scope,
  cfg: WarehousdConfig,
  collection: string,
): Promise<number> {
  const counts = await countDocumentsIn(pools, scope, cfg, [collection]);
  return counts[collection] ?? 0;
}

/**
 * The same count for several collections, in one transaction. Collections with no view in this
 * environment are absent from the result rather than zero.
 *
 * The collections list renders a count per row, and a deployment may configure twenty of them.
 * Twenty calls to countDocuments is twenty connection acquisitions and twenty transactions for
 * twenty scalars, on the page an admin opens first.
 */
export async function countDocumentsIn(
  pools: Pools,
  scope: Scope,
  cfg: WarehousdConfig,
  collections: string[],
): Promise<Record<string, number>> {
  const names = collections.filter((name) => {
    if (!findCollection(cfg, name)) throw new Error(`Unknown collection: ${name}`);
    return true;
  });
  if (!names.length) return {};
  const schema = dataSchema(scope.env);

  return withOrg(dataPool(pools, scope), scope.orgId, async (client) => {
    // Which of them exist here, asked once. A collection declared in the YAML but never applied
    // to this environment has no view, and in Postgres a failed statement aborts the whole
    // transaction — so finding out one `select` at a time would lose every count after the
    // first miss. Both interpolated parts are bound parameters quoted by format('%I').
    const present = new Set(
      (
        await client.query<{ name: string }>(
          `select name from unnest($1::text[]) as t(name)
            where to_regclass(format('%I.%I', $2::text, 'v_' || t.name)) is not null`,
          [names, schema],
        )
      ).rows.map((r) => r.name),
    );

    const out: Record<string, number> = {};
    for (const name of names) {
      if (!present.has(name)) continue;
      const r = await client.query<{ n: string }>(
        `select count(*)::text as n from ${viewOf(cfg, scope.env, name)}`,
      );
      out[name] = Number(r.rows[0]?.n ?? 0);
    }
    return out;
  });
}

/**
 * The indexed files behind a file collection, newest first.
 *
 * The view is already `{c}__files` joined to `{c}__documents`, and it is the only relation the
 * read role holds SELECT on, so the grouping happens over the view rather than over the base
 * tables. One row per file; `documentCount` is how many chunks that file produced.
 */
export async function listFiles(
  pools: Pools,
  scope: Scope,
  cfg: WarehousdConfig,
  collection: string,
): Promise<FileSummary[]> {
  const c = findCollection(cfg, collection);
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  // A file inventory only means anything for a kind that ingests files.
  if (!kindOf(c).chunked) throw new Error(`Collection ${collection} is not a file collection`);
  const view = viewOf(cfg, scope.env, collection);

  const r = await withOrg(dataPool(pools, scope), scope.orgId, (client) =>
    client.query<{
      id: string;
      title: string | null;
      path: string;
      owner: string | null;
      updated_at: Date;
      checksum: string;
      n: string;
    }>(
      `select file_id as id, title, path, owner, updated_at, checksum, count(*)::text as n
         from ${view}
        group by file_id, title, path, owner, updated_at, checksum
        order by updated_at desc, title asc`,
    ),
  );
  return r.rows.map((x) => ({
    id: x.id,
    title: x.title,
    path: x.path,
    owner: x.owner,
    updated_at: new Date(x.updated_at).toISOString(),
    checksum: x.checksum,
    documentCount: Number(x.n),
  }));
}

/**
 * How many documents carry each term of a vocabulary bound to this collection.
 *
 * A `multiple: true` vocabulary is a `text[]` column (apply/ddl.ts), so its rows have to be
 * unnested before they can be grouped — counting the column directly would count arrays, not
 * terms. Terms with no documents are absent rather than zero: the caller knows the full term
 * list from app.terms and can fill the gaps, and this function only reports what is there.
 */
export async function countTermUsage(
  pools: Pools,
  scope: Scope,
  cfg: WarehousdConfig,
  collection: string,
  vocabSlug: string,
): Promise<Record<string, number>> {
  const c = findCollection(cfg, collection);
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  if (!(c.taxonomies ?? []).includes(vocabSlug))
    throw new Error(`Collection ${collection} does not bind vocabulary ${vocabSlug}`);
  const view = viewOf(cfg, scope.env, collection);
  const col = ident(vocabSlug);
  const multiple = cfg.taxonomies[vocabSlug]?.multiple ?? false;

  const text = multiple
    ? `select t as term, count(*)::text as n from ${view}, unnest(${col}) t group by t`
    : `select ${col} as term, count(*)::text as n from ${view} where ${col} is not null group by ${col}`;

  const r = await withOrg(dataPool(pools, scope), scope.orgId, (client) =>
    client.query<{ term: string; n: string }>(text),
  );
  return Object.fromEntries(r.rows.map((x) => [x.term, Number(x.n)]));
}
