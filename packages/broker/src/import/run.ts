import type { WarehousdConfig } from "../config/schema";
import type { Pools } from "../db/pools";
import { writeAudit } from "../audit/write";
import { parseImportPayload } from "./csv";
import { validateImportRows, type ImportError } from "./validate";
import { loadTaxonomyBindings, syncDatasetTerms } from "../taxonomy";

export type ImportResult =
  | { ok: true; imported: number; columns: string[]; auditId: string }
  | { ok: false; reason: string; errors?: ImportError[]; auditId: string | null };

// The single write path into data_live: real data arrives through the admin import path,
// never through a deploy or a seeder. Three properties the tests pin down:
//
//   1. Atomic — a partially applied file is worse than a rejected one.
//   2. Append-only — no ON CONFLICT DO UPDATE. The role has no UPDATE privilege, so a
//      duplicate key surfaces as a refusal instead of silently rewriting real data.
//   3. Audited on every outcome, through the app pool. The import role cannot reach `app`,
//      which is deliberate: the writer of data is not the writer of its own audit trail.
export async function importCollection(
  pools: Pools,
  cfg: WarehousdConfig,
  actor: string,
  collection: string,
  payload: { text: string; format: "csv" | "json" },
): Promise<ImportResult> {
  const audit = (outcome: "allowed" | "refused", reason: string | null, extra: Record<string, unknown>) =>
    writeAudit(pools.app, {
      userId: actor, env: "live", collection,
      // Column names and counts only — never a cell value. An import file may carry real
      // personal data and the audit log is queryable by every admin.
      intent: { op: "import", format: payload.format, ...extra } as never,
      fieldsReturned: [], grantId: null, outcome, reason,
    });

  if (!pools.imp) {
    return { ok: false, reason: "import_not_configured", auditId: null };
  }

  let rows: Record<string, unknown>[];
  try {
    rows = parseImportPayload(payload.text, payload.format);
  } catch {
    const auditId = await audit("refused", "parse_failed", { rows: 0 });
    return { ok: false, reason: "parse_failed", auditId };
  }

  // Resolve the bound vocabularies here so that validation — which is synchronous and holds no
  // database handle — can check a dataset-sourced column instead of refusing it outright.
  // `live` is not a choice: an import writes data_live only, and the live term set is what a
  // grant on this data will be matched against.
  let taxonomies;
  try {
    taxonomies = await loadTaxonomyBindings(pools.app, cfg, collection, "live");
  } catch {
    // Unknown collection, or a vocabulary this stack never applied. Leave the bindings absent
    // and let validateImportRows report it — an unresolvable vocabulary must not read as an
    // empty term set, which would silently reject every row for the wrong reason.
    taxonomies = undefined;
  }

  const v = validateImportRows(cfg, collection, rows, { taxonomies });
  if (!v.ok) {
    const auditId = await audit("refused", "validation_failed", { rows: rows.length });
    return { ok: false, reason: "validation_failed", errors: v.errors, auditId };
  }

  // `collection` and every column name were validated against the loaded config above, so
  // these identifiers are safe to interpolate — SQL identifiers cannot be parameterized.
  // Every VALUE is parameterized.
  const cols = v.columns.map((c) => `"${c}"`).join(", ");
  const client = await pools.imp.connect();
  try {
    await client.query("begin");
    for (const row of v.values) {
      const holes = row.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(
        `insert into data_live.${collection} (${cols}) values (${holes})`, row);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    const code = (e as { code?: string }).code;
    // 23xxx = integrity constraint violation (unique, FK, not-null, check).
    const reason = code?.startsWith("23") ? "constraint_violation" : "write_failed";
    const auditId = await audit("refused", reason, { rows: v.values.length });
    return { ok: false, reason, auditId };
  } finally {
    client.release();
  }

  // Imported rows may be the source of a dataset-backed vocabulary, so the live term set is
  // stale the moment the transaction commits. Refreshing here — rather than at each call site —
  // is what keeps a later `indexCollection` from throwing on an unknown term.
  await syncDatasetTerms(pools.app, cfg, "live");

  const auditId = await audit("allowed", null, { rows: v.values.length, columns: v.columns });
  return { ok: true, imported: v.values.length, columns: v.columns, auditId };
}
