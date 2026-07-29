import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import { makeRng, genValue } from "./generators";

// Generates in FK dependency order so parent ids exist before children reference them.
export async function generateSynthetic(db: Pool, cfg: WarehousdConfig, seed: number): Promise<void> {
  const rng = makeRng(seed);
  const idsByCollection: Record<string, string[]> = {};
  const order = topoSort(cfg);
  const deferred: { collection: string; column: string; parent: string; pk: string }[] = [];

  for (const name of order) {
    const c = cfg.collections[name];
    if (!c) throw new Error(`Unknown collection: ${name}`);
    // Skip file collections — they are populated via indexCollection, not synthetic generation
    if (c.type === "file") continue;
    const n = cfg.synthetic.documents_per_collection[name] ?? 20;
    const storedFields = Object.entries(c.fields).filter(([, f]) => !f.view_join);
    // Build term slug sets for each bound vocabulary. Only YAML vocabularies have terms to
    // draw from: a dataset-sourced one is populated by syncDatasetTerms, which by construction
    // runs *after* this — the rows it reads are the ones being generated here. Such a column
    // is left NULL, and stays NULL, since nothing back-fills it. Harbor binds `client` only to
    // a file collection (skipped above), so this is a latent shape rather than a live one.
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
      if (f.pk) { pkField = fname; break; }
    }
    for (let i = 0; i < n; i++) {
      const cols: string[] = [], vals: unknown[] = [];
      for (const [fname, f] of storedFields) {
        cols.push(`"${fname}"`);
        if (f.pk) { const id = genValue(rng, "uuid", fname, { i, project: cfg.project, gen: f.gen }) as string; ids.push(id); vals.push(id); }
        else if (f.fk) {
          const [parent] = f.fk.split("."); // "people.id"
          const parentExists = parent && Object.prototype.hasOwnProperty.call(idsByCollection, parent);
          const parentIds = parentExists ? (idsByCollection[parent] ?? []) : [];
          if (!parentIds.length && parent && !parentExists) {
            // Parent hasn't been visited yet — defer this FK for backfill
            const deferKey = `${name}:${fname}`;
            if (!deferred.some((d) => `${d.collection}:${d.column}` === deferKey)) {
              // The backfill addresses rows by primary key, so without one it would emit
              // `where ""=$2`. Fail here, naming the collection, rather than at query time.
              if (!pkField)
                throw new Error(`collection "${name}" needs a pk to back-fill the deferred fk "${fname}"`);
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
        else vals.push(genValue(rng, f.type!, fname, { min: f.min, max: f.max, gen: f.gen, i, project: cfg.project }));
      }
      const ph = vals.map((_, k) => `$${k + 1}`).join(",");
      await db.query(`insert into data_synth.${name} (${cols.join(",")}) values (${ph})`, vals);
    }
    idsByCollection[name] = ids;
  }

  // Second pass: backfill deferred FKs
  for (const d of deferred) {
    const parentIds = idsByCollection[d.parent] ?? [];
    const rowIds = idsByCollection[d.collection] ?? [];
    if (!parentIds.length || !rowIds.length) continue;
    for (const rowId of rowIds) {
      const pick = parentIds[Math.floor(rng() * parentIds.length)];
      if (!pick || pick === rowId) continue; // nobody is their own manager/head
      await db.query(
        `update data_synth.${d.collection} set "${d.column}"=$1 where "${d.pk}"=$2`, [pick, rowId]);
    }
  }
}

function topoSort(cfg: WarehousdConfig): string[] {
  const names = Object.keys(cfg.collections);
  const deps = (n: string) => Object.values(cfg.collections[n]?.fields ?? {})
    .map((f) => f.fk?.split(".")[0]).filter((x): x is string => !!x && names.includes(x));
  const out: string[] = [], seen = new Set<string>();
  const visit = (n: string) => { if (seen.has(n)) return; seen.add(n); deps(n).forEach(visit); out.push(n); };
  names.forEach(visit);
  return out;
}
