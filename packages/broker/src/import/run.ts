import type { PoolClient } from "pg";
import type { WarehousdConfig } from "../config/schema";
import type { Pools } from "../db/pools";
import { withWorkspace } from "../db/pools";
import { insertRevision, currentRevision, reviseDocument } from "../db/revisions";
import { pkOf, dataColsOf } from "../config/collection";
import { ident } from "../sql/ident";
import { DEFAULT_WORKSPACE_ID } from "../db/migrate-app";
import { makeAuditWriter, auditDestination } from "../audit/decision";
import type { BrokerContext } from "../types";
import { writeChangeLog } from "../verbs/history";
import { auditEnabled, findCollection } from "../config/load";
import { parseImport, type ImportPayload } from "./csv";
import type { SheetReader } from "./sheet";
import {
  validateImportRows,
  summarizeImportErrors,
  type ImportError,
  type ImportErrorSummary,
} from "./validate";
import { loadTaxonomyBindings, syncDatasetTerms, type TaxonomyBinding } from "../taxonomy";

// The three things an admin can do to real data. All three are APPENDS at the storage layer:
// `upsert` and `delete` write new revisions and retire the ones they supersede, so nothing in
// data_live is ever rewritten or destroyed. The import role holds no UPDATE on a data column
// and no DELETE at all — see grantImportDDL — which is what makes that a privilege rather than
// a convention this file could quietly break.
export const IMPORT_MODES = ["append", "upsert", "delete"] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export type ImportCounts = { inserted: number; updated: number; deleted: number };

// How far through the file an import is, in the shape EmbedProgress already had. `total` is always
// known — validation has already counted the rows — so the CLI can render a rate and an ETA.
//
// Reported from inside the transaction, which is where the work happens. A dry run reports the
// same numbers and then rolls the whole thing back; that is the point of a dry run.
export type ImportProgress = { done: number; total: number; phase: "check" | "write" };

export type ImportResult =
  // `auditId` is nullable on the success arm too: a deployment with `audit.enabled: false`
  // writes no row, and fabricating an id for one that does not exist would be worse than saying
  // there isn't one.
  | ({
      ok: true;
      mode: ImportMode;
      dryRun: boolean;
      columns: string[];
      auditId: string | null;
    } & ImportCounts)
  | {
      ok: false;
      reason: string;
      errors?: ImportError[];
      // The aggregation both the CLI and /admin/import render from. Present wherever `errors` is:
      // fifty row numbers out of ten thousand is not a diagnosis, and the two surfaces must not
      // each invent their own way of saying so. See summarizeImportErrors.
      summary?: ImportErrorSummary;
      auditId: string | null;
    };

// Thrown to unwind the import transaction on a dry run. withWorkspace rolls back on any throw, which
// is the whole mechanism: a preview runs the real statements against the real table and then
// declines to keep them, so what it reports is what would happen rather than a second guess at it.
class DryRunRollback extends Error {
  constructor(readonly counts: ImportCounts) {
    super("dry run");
  }
}

// Per-row problems discovered once the transaction is already open — a delete naming a document
// that is not there, an upsert-create missing a required column. Carried out as a throw so the
// transaction unwinds and the file stays all-or-nothing.
class RowErrors extends Error {
  constructor(readonly errors: ImportError[]) {
    super("row errors");
  }
}

// The single write path into data_live: real data arrives through the admin import path,
// never through a deploy or a seeder. Four properties the tests pin down:
//
//   1. Atomic — a partially applied file is worse than a rejected one.
//   2. Append-only — every mode writes revisions; none rewrites or removes a stored row.
//   3. Audited on every outcome, through the app pool — unless the deployment has turned the
//      trail off (`audit.enabled: false`). The import role cannot reach `app`, which is
//      deliberate: the writer of data is not the writer of its own audit trail.
//   4. Previewable — `dryRun` runs the whole thing and rolls back.
export async function importCollection(
  pools: Pools,
  cfg: WarehousdConfig,
  actor: string,
  collection: string,
  payload: ImportPayload,
  opts: {
    mode?: ImportMode;
    dryRun?: boolean;
    workspaceId?: string;
    onProgress?: ((p: ImportProgress) => void) | undefined;
    // Which credential drove this, for the audit row — `session` from the console, `cli` from
    // `warehousd import run`. Defaults to `session`, which is where imports came from first.
    via?: string;
    // Injected for `format: "xlsx"`, never constructed here — see import/csv.ts.
    sheets?: SheetReader | undefined;
  } = {},
): Promise<ImportResult> {
  const mode: ImportMode = opts.mode ?? "append";
  const dryRun = opts.dryRun ?? false;
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE_ID;

  // Through `makeAuditWriter` like every broker decision, not through a direct insert.
  //
  // An import is not a grant decision, but it is the single write path into data_live and it goes
  // in the same trail — so it has to reach the same DESTINATION. While this called `writeAudit`
  // directly it always landed in `app.audit_events`, which meant a deployment forwarding its trail
  // to a SIEM (`audit.sink: webhook`) silently lost the highest-volume event it has. Going through
  // the writer also brings the rest of it for free: `audit.enabled` honoured in one place, the
  // redacted operator log line on a failed write, and `workspace_id`/`via`/`principals` filled from the
  // context rather than from a hand-written column list.
  //
  // `env` is the literal 'live'. An import cannot touch data_synth, so there is no caller
  // environment to read here.
  const auditCtx: BrokerContext = {
    userId: actor,
    workspaceId,
    env: "live",
    allowedCollections: null,
    via: opts.via ?? "session",
  };
  const writer = makeAuditWriter(pools.app, auditCtx, auditEnabled(cfg), auditDestination(cfg));

  // Column names and counts only — never a cell value. An import file may carry real personal
  // data and the audit log is queryable by every admin.
  const intentFor = (extra: Record<string, unknown>) => ({
    op: `import:${mode}`,
    format: payload.format,
    dryRun,
    ...extra,
  });

  const audit = async (
    outcome: "allowed" | "refused",
    reason: string | null,
    extra: Record<string, unknown>,
  ): Promise<string | null> => {
    const detail = { intent: intentFor(extra) };
    if (outcome === "refused")
      return (await writer.refuse(collection, reason ?? "refused", detail)).auditId;
    // Deliberately NOT downgraded to a refusal the way a read is. The rows are already committed
    // by the time this runs — the audit row goes through the app pool, which the import role
    // cannot reach, so it cannot join the import's transaction and cannot be rolled back with it.
    // Telling the caller the import failed when the data is in the table would be a worse lie than
    // a null id, and the writer has already logged the failure loudly for the operator.
    const rec = await writer.allow(collection, detail);
    return rec.ok ? rec.auditId : null;
  };

  if (!IMPORT_MODES.includes(mode)) {
    return { ok: false, reason: "unknown_mode", auditId: null };
  }
  if (!pools.imp) {
    return { ok: false, reason: "import_not_configured", auditId: null };
  }

  const c = findCollection(cfg, collection);
  if (!c) {
    const auditId = await audit("refused", "unknown_collection", { rows: 0 });
    return { ok: false, reason: "unknown_collection", auditId };
  }
  const pk = pkOf(c);
  // upsert and delete address an existing document, and a collection with no declared pk has no
  // document identity to address one by. Append does not need one.
  if (mode !== "append" && !pk) {
    const auditId = await audit("refused", "no_primary_key", { rows: 0 });
    return { ok: false, reason: "no_primary_key", auditId };
  }

  let rows: Record<string, unknown>[];
  try {
    rows = parseImport(payload, { sheets: opts.sheets });
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
    taxonomies = await loadTaxonomyBindings(pools.app, cfg, collection, "live", workspaceId);
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

  const v = validateImportRows(cfg, collection, rows, { taxonomies, mode });
  if (!v.ok) {
    const auditId = await audit("refused", "validation_failed", { rows: rows.length });
    return {
      ok: false,
      reason: "validation_failed",
      errors: v.errors,
      summary: v.summary,
      auditId,
    };
  }

  // `collection` and every column name were validated against the loaded config above, so these
  // identifiers are safe to interpolate — SQL identifiers cannot be parameterized. Every VALUE
  // is parameterized, by insertRevision and reviseDocument.
  const table = `data_live.${ident(collection)}`;
  const dataCols = dataColsOf(c);
  // Columns the config says must carry a value. Only checked on the rows that turn out to be
  // inserts: an upsert file that sets one column on 500 existing documents is the normal case,
  // and demanding every required column there would make upsert useless for editing.
  const requiredCols = Object.entries(c.fields)
    .filter(([, f]) => !f.view_join && !f.nullable)
    .map(([n]) => n);
  // Written to app.change_log after the data transaction commits — the import role has no
  // privileges in `app` at all, and giving it some to write its own feed entry would undo the
  // separation the audit path already relies on.
  const feed: { documentId: string; rev: string; op: string }[] = [];

  const docOf = (row: unknown[]): Record<string, unknown> => {
    const doc: Record<string, unknown> = {};
    v.columns.forEach((col, i) => {
      doc[col] = row[i];
    });
    return doc;
  };
  // A pk is a scalar; `unknown` only to the compiler, exactly as in validate.ts.
  const idOf = (doc: Record<string, unknown>): string => String(doc[pk!]);
  // The `create` revision every insert below writes, so the shape is stated once.
  const create = (fields: string[]) =>
    ({
      seq: 1,
      op: "create" as const,
      status: "approved" as const,
      fields,
      base: null,
      current: true,
      by: actor,
      workspaceId,
    }) as const;

  let counts: ImportCounts;
  try {
    counts = await withWorkspace(pools.imp, workspaceId, async (client) => {
      const n: ImportCounts = { inserted: 0, updated: 0, deleted: 0 };

      // A delete file naming documents that are not there is almost always the wrong file, and
      // the collection is all-or-nothing anyway, so it is refused rather than partly applied.
      // Gathered up-front so the report names every bad row at once instead of the first.
      if (mode === "delete") {
        const missing: ImportError[] = [];
        for (const [idx, row] of v.values.entries()) {
          const doc = docOf(row);
          if (!(await currentRevision(client, table, pk!, doc[pk!], "")))
            missing.push({ row: idx, column: pk, reason: "not_found", scope: "row" });
          opts.onProgress?.({ done: idx + 1, total: v.values.length, phase: "check" });
        }
        if (missing.length) throw new RowErrors(missing);
      }

      for (const [idx, row] of v.values.entries()) {
        const doc = docOf(row);
        opts.onProgress?.({ done: idx, total: v.values.length, phase: "write" });

        if (mode === "append") {
          const rev = await insertRevision(client, table, dataCols, create(v.columns), doc);
          n.inserted++;
          // A collection with no pk has no document identity, so there is nothing for a feed
          // entry to name. It still gets its revision and its audit row.
          if (pk) feed.push({ documentId: idOf(doc), rev, op: "create" });
          continue;
        }

        const current = await currentRevision(client, table, pk!, doc[pk!], "");

        if (mode === "delete") {
          // currentRevision was non-null in the sweep above and this is the same transaction.
          const rev = await reviseDocument(
            client,
            table,
            dataCols,
            current!,
            {},
            {
              op: "delete",
              status: "approved",
              by: actor,
              workspaceId,
            },
          );
          n.deleted++;
          feed.push({ documentId: idOf(doc), rev, op: "delete" });
          continue;
        }

        if (current) {
          // Only the columns the file carries are changed; reviseDocument carries the rest
          // forward, so an upsert that sets one column does not blank the other twenty.
          //
          // The pk is dropped first. In an upsert file it is the ADDRESS — it is how this row
          // was found — not something the import is changing, and its value is by definition
          // the one already stored. Leaving it in put the pk in `_rev_fields`, which says the
          // import edited the document's identity: wrong in the change feed, wrong in the
          // history, and a source of phantom conflicts in approveProposal, which intersects
          // `_rev_fields` to decide whether a proposal still applies. The direct write path
          // refuses a pk on an update outright for the same reason ("changing identity is not
          // an edit"), and test/revision-parity.test.ts is what holds the two together.
          const { [pk!]: _addressed, ...changed } = doc;
          const rev = await reviseDocument(client, table, dataCols, current, changed, {
            op: "update",
            status: "approved",
            by: actor,
            workspaceId,
          });
          n.updated++;
          feed.push({ documentId: idOf(doc), rev, op: "update" });
          continue;
        }

        // Upsert reached a document that does not exist, so this row is a create — and a create
        // is the one case where the config's required columns actually have to be there.
        const missing = requiredCols.filter((col) => doc[col] === undefined || doc[col] === null);
        if (missing.length)
          throw new RowErrors(
            missing.map((col) => ({
              row: idx,
              column: col,
              reason: "missing_required",
              scope: "row" as const,
            })),
          );
        const rev = await insertRevision(client, table, dataCols, create(v.columns), doc);
        n.inserted++;
        feed.push({ documentId: idOf(doc), rev, op: "create" });
      }

      opts.onProgress?.({ done: v.values.length, total: v.values.length, phase: "write" });
      if (dryRun) throw new DryRunRollback(n);
      return n;
    });
  } catch (e) {
    if (e instanceof DryRunRollback) {
      const auditId = await audit("allowed", null, {
        rows: v.values.length,
        columns: v.columns,
        ...e.counts,
      });
      return {
        ok: true,
        mode,
        dryRun: true,
        columns: v.columns,
        auditId,
        ...e.counts,
      };
    }
    if (e instanceof RowErrors) {
      const auditId = await audit("refused", "validation_failed", { rows: v.values.length });
      // Discovered inside the transaction, so there is no validation summary to carry — these are
      // built from the array, which is complete here because the loop throws on the first batch.
      return {
        ok: false,
        reason: "validation_failed",
        errors: e.errors,
        summary: summarizeImportErrors(e.errors, v.values.length),
        auditId,
      };
    }
    const code = (e as { code?: string }).code;
    // 23xxx = integrity constraint violation (unique, FK, not-null, check). On append that is
    // most often a pk that already has a current revision: appending a second `create` for a
    // document that exists is what upsert is for, so it stays a refusal rather than becoming a
    // silent overwrite.
    const reason = code?.startsWith("23") ? "constraint_violation" : "write_failed";
    const auditId = await audit("refused", reason, { rows: v.values.length });
    return { ok: false, reason, auditId };
  }

  // Imported rows may be the source of a dataset-backed vocabulary, so the live term set is
  // stale the moment the transaction commits. Refreshing here — rather than at each call site —
  // is what keeps a later `indexCollection` from throwing on an unknown term.
  await syncDatasetTerms(pools.app, cfg, "live", workspaceId);
  await appendToFeed(pools, actor, workspaceId, collection, feed);

  const auditId = await audit("allowed", null, {
    rows: v.values.length,
    columns: v.columns,
    ...counts,
  });
  return { ok: true, mode, dryRun: false, columns: v.columns, auditId, ...counts };
}

// The change feed entries for an import, written through the APP pool once the data is committed.
// Deliberately not inside the import transaction: the import role has no privileges in `app`, and
// the point of that is that the writer of data is not the writer of its own trail. A failure here
// costs a feed entry, never the data or the audit row, so it is logged and swallowed.
async function appendToFeed(
  pools: Pools,
  actor: string,
  workspaceId: string,
  collection: string,
  feed: { documentId: string; rev: string; op: string }[],
): Promise<void> {
  if (!feed.length) return;
  const ctx = {
    userId: actor,
    workspaceId,
    env: "live" as const,
    allowedCollections: null,
    via: "session",
  };
  try {
    await withWorkspace(pools.app, workspaceId, async (client: PoolClient) => {
      for (const e of feed)
        await writeChangeLog(client, ctx, collection, e.documentId, e.rev, e.op, "approved");
    });
  } catch (err) {
    console.error("[broker] import change feed write failed", { collection, err });
  }
}
