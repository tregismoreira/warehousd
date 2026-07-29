import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import { makeRng, genValue } from "./generators";

// Generates in FK dependency order so parent ids exist before children reference them.
export async function generateSynthetic(db: Pool, cfg: WarehousdConfig, seed: number): Promise<void> {
  const rng = makeRng(seed);
  const idsByCollection: Record<string, string[]> = {};
  const order = topoSort(cfg);

  for (const name of order) {
    const c = cfg.collections[name];
    if (!c) throw new Error(`Unknown collection: ${name}`);
    // Skip file collections — they are populated via indexCollection, not synthetic generation
    if (c.type === "file") continue;
    // Skip writable collections — their base table has NOT NULL revision columns
    // (_rev_seq, _rev_by, _rev_op, ...) that a plain synthetic insert doesn't populate;
    // content comes from real writes/proposals, not synthetic filler.
    if (c.writable) continue;
    const n = cfg.synthetic.documents_per_collection[name] ?? 20;
    const storedFields = Object.entries(c.fields).filter(([, f]) => !f.view_join);
    const termSlugs = c.taxonomy ? Object.keys(cfg.taxonomies[c.taxonomy]?.terms ?? {}) : null;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const cols: string[] = [], vals: unknown[] = [];
      for (const [fname, f] of storedFields) {
        cols.push(`"${fname}"`);
        if (f.pk) { const id = genValue(rng, "uuid", fname) as string; ids.push(id); vals.push(id); }
        else if (f.fk) {
          const [parent] = f.fk.split("."); // "people.id"
          const parentIds = (parent && idsByCollection[parent]) ?? [];
          vals.push(parentIds[Math.floor(rng() * parentIds.length)] ?? null);
        } else if (fname === c.taxonomy && termSlugs && termSlugs.length)
          vals.push(termSlugs[Math.floor(rng() * termSlugs.length)]);
        else if (f.nullable && rng() < 0.05) vals.push(null);
        // type is guaranteed by CollectionSchema refinement for structured collections; file collections have types filled in by transform
        else vals.push(genValue(rng, f.type!, fname, { min: f.min, max: f.max }));
      }
      const ph = vals.map((_, k) => `$${k + 1}`).join(",");
      await db.query(`insert into data_synth.${name} (${cols.join(",")}) values (${ph})`, vals);
    }
    idsByCollection[name] = ids;
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
