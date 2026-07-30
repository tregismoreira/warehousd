import type { WarehousdConfig } from "../config/schema";
import type { Pools } from "../db/pools";
import { withOrg } from "../db/pools";
import { DEFAULT_ORG_ID } from "../db/migrate-app";
import { writeAudit } from "../audit/write";
import { parseImportPayload } from "./csv";
import { validateImportRows, type ImportError } from "./validate";
import { loadTaxonomyBindings, syncDatasetTerms, type TaxonomyBinding } from "../taxonomy";

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
  orgId: string = DEFAULT_ORG_ID,
): Promise<ImportResult> {
  const audit = (outcome: "allowed" | "refused", reason: string | null, extra: Record<string, unknown>) =>
    writeAudit(pools.app, {
      userId: actor, env: "live", collection, orgId,
      // Column names and counts only — never a cell value. An import file may carry real
      // personal data and the audit log is queryable by every admin.
      intent: { op: "import", format: payload.format, ...extra },
      fieldsReturned: [], grantId: null, outcome, reason, via: "session",
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
  let taxonomies: TaxonomyBinding[] | undefined;
  try {
    taxonomies = await loadTaxonomyBindings(pools.app, cfg, collection, "live");
  } catch (e) {
    // Two very different failures reach here, and they must not collapse into one.
    //
    // An unknown collection, or a vocabulary this stack never applied, throws a plain Error.
    // That is a real answer: the terms are genuinely unresolvable, so leave the bindings
    // absent and let validateImportRows refuse the column as `unvalidatable_term`. What it
    // must not do is read as an empty term set, which would reject every row as `unknown_term`
    // — the right refusal for the wrong reason.
    //
    // A driver or server error carries a pg `code` and is not an answer at all. Blaming the
    // config for an outage would send an admin to fix a vocabulary that was never broken, so
    // refuse under its own reason instead. Same `code` sniffing as the insert path below.
    if ((e as { code?: string }).code !== undefined) {
      const auditId = await audit("refused", "taxonomy_unavailable", { rows: rows.length });
      return { ok: false, reason: "taxonomy_unavailable", auditId };
    }
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
  // org_id is written explicitly rather than left to the column default: the RLS policy's
  // WITH CHECK compares it against warehousd.org_id, and a mismatch must fail the insert
  // rather than be silently corrected by a default.
  const cols = ["org_id", ...v.columns].map((c) => `"${c}"`).join(", ");
  try {
    await withOrg(pools.imp, orgId, async (client) => {
      for (const row of v.values) {
        const values = [orgId, ...row];
        const holes = values.map((_, i) => `$${i + 1}`).join(", ");
        await client.query(
          `insert into data_live.${collection} (${cols}) values (${holes})`, values);
      }
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    // 23xxx = integrity constraint violation (unique, FK, not-null, check).
    const reason = code?.startsWith("23") ? "constraint_violation" : "write_failed";
    const auditId = await audit("refused", reason, { rows: v.values.length });
    return { ok: false, reason, auditId };
  }

  // Imported rows may be the source of a dataset-backed vocabulary, so the live term set is
  // stale the moment the transaction commits. Refreshing here — rather than at each call site —
  // is what keeps a later `indexCollection` from throwing on an unknown term.
  await syncDatasetTerms(pools.app, cfg, "live");

  const auditId = await audit("allowed", null, { rows: v.values.length, columns: v.columns });
  return { ok: true, imported: v.values.length, columns: v.columns, auditId };
}
