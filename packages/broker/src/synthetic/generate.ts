import { randomUUID } from "node:crypto";
import { kindOf } from "../config/kinds";
import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import { loadTaxonomyBindings, syncDatasetTerms } from "../taxonomy";
import { withWorkspace } from "../db/pools";
import { makeRng, genValue } from "./generators";

// Generated rows are revisions like any other: every dataset table carries REV_COLS, so a plain
// insert would fail on the NOT NULL bookkeeping columns. A synthetic document is the `create`
// revision of a document that has never been edited — seq 1, approved, current — and `_rev_by`
// names the generator rather than a person, so the change feed and the revision history read
// truthfully for data nobody wrote.
const SYNTHETIC_AUTHOR = "synthetic";
const REV_INSERT_COLS = [
  `"_rev"`,
  `"_rev_seq"`,
  `"_rev_by"`,
  `"_rev_op"`,
  `"_rev_status"`,
  `"_rev_fields"`,
  `"_current"`,
  `"workspace_id"`,
];
const revInsertValues = (fields: string[], workspaceId: string): unknown[] => [
  randomUUID(),
  1,
  SYNTHETIC_AUTHOR,
  "create",
  "approved",
  fields,
  true,
  workspaceId,
];

// Which collection the generator is on, in the shape EmbedProgress already had. The total is the
// number of collections rather than of documents: generation runs in FK dependency order, and a
// document count would jump about as it moved between a 20-row table and a 4,000-row one.
export type SyntheticProgress = { done: number; total: number; label: string };

// Generates in FK dependency order so parent ids exist before children reference them.
export async function generateSynthetic(
  db: Pool,
  cfg: WarehousdConfig,
  seed: number,
  workspaceId: string,
  opts: { onProgress?: ((p: SyntheticProgress) => void) | undefined } = {},
): Promise<void> {
  const rng = makeRng(seed);
  const idsByCollection: Record<string, string[]> = {};
  const pkByCollection: Record<string, string> = {};
  const order = topoSort(cfg);
  const deferred: { collection: string; column: string; parent: string; pk: string }[] = [];

  for (const [i, name] of order.entries()) {
    opts.onProgress?.({ done: i, total: order.length, label: name });
    const c = cfg.collections[name];
    if (!c) throw new Error(`Unknown collection: ${name}`);
    // A kind the generator cannot produce is populated some other way — a file collection by
    // indexCollection. The kind says so; this loop does not know which kinds those are.
    if (!kindOf(c).synthesisable) continue;
    // Skip writable collections — their content comes from real writes and proposals, not from
    // synthetic filler, and truncating one would destroy a pending proposal. (Revision columns
    // are no longer the reason: every dataset has them, and the insert below fills them.)
    if (c.writable) continue;
    const n = cfg.synthetic.documents_per_collection[name] ?? 20;
    const storedFields = Object.entries(c.fields).filter(([, f]) => !f.view_join);
    // Build term slug sets for each bound vocabulary. Only YAML vocabularies have terms to
    // draw from here: a dataset-sourced one is populated by syncDatasetTerms, which by
    // construction cannot run yet — the rows it reads are the ones being generated below.
    // Those columns are left NULL and back-filled by the third pass at the end.
    const termsByVocab = new Map<string, string[]>();
    for (const taxSlug of c.taxonomies ?? []) {
      const vocab = cfg.taxonomies[taxSlug];
      if (vocab?.terms) {
        termsByVocab.set(taxSlug, Object.keys(vocab.terms));
      }
    }
    const ids: string[] = [];
    // Find the primary key field
    let pkField = "";
    for (const [fname, f] of storedFields) {
      if (f.pk) {
        pkField = fname;
        break;
      }
    }
    if (pkField) pkByCollection[name] = pkField;
    // Rows are accumulated and inserted in batches rather than one statement each.
    //
    // A round trip per row was tolerable when a row was its declared fields; every dataset is
    // revisioned now, so each one also carries seven bookkeeping columns, and harbor generates
    // a few thousand rows. One statement per row made `warehousd seed` — and the regenerate
    // suite — slow enough to cross a 30s test timeout under parallel load.
    const pending: unknown[][] = [];
    let pendingCols: string[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const allCols = [...REV_INSERT_COLS, ...pendingCols];
      const width = allCols.length;
      const params: unknown[] = [];
      const tuples = pending.map((row, r) => {
        const holes = row.map((_, k) => `$${r * width + k + 1}`);
        params.push(...row);
        return `(${holes.join(",")})`;
      });
      await withWorkspace(db, workspaceId, (client) =>
        client.query(
          `insert into data_synth.${name} (${allCols.join(",")}) values ${tuples.join(",")}`,
          params,
        ),
      );
      pending.length = 0;
    };
    for (let i = 0; i < n; i++) {
      const cols: string[] = [],
        vals: unknown[] = [];
      for (const [fname, f] of storedFields) {
        cols.push(`"${fname}"`);
        if (f.pk) {
          const id = genValue(rng, "uuid", fname, {
            i,
            project: cfg.project,
            gen: f.gen,
          }) as string;
          ids.push(id);
          vals.push(id);
        } else if (f.fk) {
          const [parent] = f.fk.split("."); // "people.id"
          const parentExists =
            parent && Object.prototype.hasOwnProperty.call(idsByCollection, parent);
          const parentIds = parentExists ? (idsByCollection[parent] ?? []) : [];
          if (!parentIds.length && parent && !parentExists) {
            // Parent hasn't been visited yet — defer this FK for backfill
            const deferKey = `${name}:${fname}`;
            if (!deferred.some((d) => `${d.collection}:${d.column}` === deferKey)) {
              // The backfill addresses rows by primary key, so without one it would emit
              // `where ""=$2`. Fail here, naming the collection, rather than at query time.
              if (!pkField)
                throw new Error(
                  `collection "${name}" needs a pk to back-fill the deferred fk "${fname}"`,
                );
              deferred.push({ collection: name, column: fname, parent, pk: pkField });
            }
            vals.push(null);
          } else {
            vals.push(parentIds[Math.floor(rng() * parentIds.length)] ?? null);
          }
        } else if ((c.taxonomies ?? []).includes(fname)) {
          const termSlugs = termsByVocab.get(fname) ?? [];
          const vocab = cfg.taxonomies[fname];
          if (vocab?.multiple && termSlugs.length) {
            // 1-3 distinct terms. Draw the fixed number of times either way so the rng stream
            // stays identical for a given seed, and drop repeats rather than re-rolling —
            // `{litigation, litigation}` is a legal array but a nonsense tag set.
            const count = Math.floor(rng() * 3) + 1;
            const selected = new Set<string>();
            for (let j = 0; j < count; j++) {
              const idx = Math.floor(rng() * termSlugs.length);
              selected.add(termSlugs[idx]!);
            }
            vals.push([...selected]);
          } else if (termSlugs.length) {
            // Single-value vocabulary
            const idx = Math.floor(rng() * termSlugs.length);
            vals.push(termSlugs[idx]);
          } else {
            vals.push(null);
          }
        } else if (f.nullable && rng() < 0.05) vals.push(null);
        // type is guaranteed by CollectionSchema refinement for structured collections; file collections have types filled in by transform
        else
          vals.push(
            genValue(rng, f.type!, fname, {
              min: f.min,
              max: f.max,
              gen: f.gen,
              i,
              project: cfg.project,
            }),
          );
      }
      // Revision bookkeeping ahead of the data columns, matching the column list built beside it.
      pendingCols = cols;
      pending.push([
        ...revInsertValues(
          cols.map((c2) => c2.replace(/"/g, "")),
          workspaceId,
        ),
        ...vals,
      ]);
      // Postgres caps a statement at 65535 bound parameters, so the batch is bounded by row
      // width rather than by a fixed row count — a wide collection would otherwise blow the
      // limit at a size that worked for a narrow one.
      if (
        pending.length >= Math.max(1, Math.floor(20_000 / (cols.length + REV_INSERT_COLS.length)))
      )
        await flush();
    }
    await flush();
    idsByCollection[name] = ids;
  }

  // Second pass: backfill deferred FKs
  //
  // Every update below carries `and workspace_id=$3` alongside the pk. The pk alone is not
  // enough: `rng` is seeded purely from the numeric `seed` argument, with no workspace mixed
  // in, so calling this function twice with the same seed for two different workspaces (the
  // common case — every caller defaults to 42) produces byte-identical ids for corresponding
  // rows. The unique index is (workspace_id, pk), which permits exactly that collision, so an
  // update addressed by pk alone would silently touch the other workspace's row too.
  for (const d of deferred) {
    const parentIds = idsByCollection[d.parent] ?? [];
    const rowIds = idsByCollection[d.collection] ?? [];
    if (!parentIds.length || !rowIds.length) continue;
    await withWorkspace(db, workspaceId, async (client) => {
      for (const rowId of rowIds) {
        const pick = parentIds[Math.floor(rng() * parentIds.length)];
        if (!pick || pick === rowId) continue; // nobody is their own manager/head
        await client.query(
          `update data_synth.${d.collection} set "${d.column}"=$1 where "${d.pk}"=$2 and workspace_id=$3`,
          [pick, rowId, workspaceId],
        );
      }
    });
  }

  // Third pass: dataset-sourced vocabularies. Their terms are distinct values of a column on
  // another collection, so the term set does not exist until that collection has rows — which
  // is why the first pass leaves these columns NULL. Sync the terms now, then fill the columns
  // with the same per-row update the FK pass uses.
  //
  // `dev` is not a guess: this function writes data_synth and nothing else. Callers run
  // syncDatasetTerms immediately afterwards anyway and it is idempotent, so this adds no
  // ordering constraint.
  const datasetSourced = order.filter((name) => {
    const c = cfg.collections[name];
    return (
      !!c &&
      kindOf(c).synthesisable &&
      (c.taxonomies ?? []).some((slug) => cfg.taxonomies[slug]?.source)
    );
  });
  if (datasetSourced.length) {
    await syncDatasetTerms(db, cfg, "dev", workspaceId);
    for (const name of datasetSourced) {
      const rowIds = idsByCollection[name] ?? [];
      const bindings = await loadTaxonomyBindings(db, cfg, name, "dev", workspaceId);
      for (const b of bindings) {
        if (!cfg.taxonomies[b.field]?.source) continue; // YAML terms were filled in pass one
        const pk = pkByCollection[name];
        // The back-fill addresses rows by primary key, exactly as the FK pass does. Fail here,
        // naming the collection, rather than emitting `where ""=$2`.
        if (!pk)
          throw new Error(
            `collection "${name}" needs a pk to back-fill the dataset-sourced vocabulary "${b.field}"`,
          );
        if (!b.slugs.length || !rowIds.length) continue;
        await withWorkspace(db, workspaceId, async (client) => {
          for (const rowId of rowIds) {
            let value: string | string[];
            if (b.multiple) {
              // Same draw as the first pass: a fixed number of rolls so the rng stream is
              // stable for a seed, with repeats dropped rather than re-rolled.
              const count = Math.floor(rng() * 3) + 1;
              const selected = new Set<string>();
              for (let j = 0; j < count; j++)
                selected.add(b.slugs[Math.floor(rng() * b.slugs.length)]!);
              value = [...selected];
            } else {
              value = b.slugs[Math.floor(rng() * b.slugs.length)]!;
            }
            await client.query(
              `update data_synth.${name} set "${b.field}"=$1 where "${pk}"=$2 and workspace_id=$3`,
              [value, rowId, workspaceId],
            );
          }
        });
      }
    }
  }
}

function topoSort(cfg: WarehousdConfig): string[] {
  const names = Object.keys(cfg.collections);
  const deps = (n: string) =>
    Object.values(cfg.collections[n]?.fields ?? {})
      .map((f) => f.fk?.split(".")[0])
      .filter((x): x is string => !!x && names.includes(x));
  const out: string[] = [],
    seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    deps(n).forEach(visit);
    out.push(n);
  };
  names.forEach(visit);
  return out;
}
