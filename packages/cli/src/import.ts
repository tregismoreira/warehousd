import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { Pool } from "pg";
import {
  createPools,
  formatImportReport,
  importCollection,
  inferCollection,
  inferMapping,
  loadConfig,
  loadTaxonomyBindings,
  parseImport,
  renderCollectionYaml,
  renderMappingYaml,
  summarizeImportErrors,
  validateImportRows,
  type ImportErrorSummary,
  type ImportFormat,
  type ImportMode,
  type ImportPayload,
  type ImportProgress,
  type InferredCollection,
  type InferredMapping,
  type WarehousdConfig,
} from "@warehousd/broker";
import { makeSheetReader } from "@warehousd/providers";
import { silentReporter, type Reporter } from "./ui/reporter";
import { trackStepWith } from "./ui/progress";

// `warehousd import map | validate | run`.
//
// Import was web-admin-only, so it could not be scripted, rerun, or put in CI — which for a
// customer whose data arrives as a monthly spreadsheet is most of the job. Two of these three are
// thin wrappers over broker functions that already existed and were already tested; `map` is the
// only genuinely new code, and it never writes warehousd.yml.
//
// **`validate`, not `check`.** The repo already draws this line: *validate* is conformance to a
// declared shape (validateImportRows, validateGrantRequest, validateVerbs), *check* is environment
// health (PreflightCheck, ProviderCheck, doctor). Data against a collection is the first thing.

export type SheetSelection = { sheet?: string | undefined; headerRow?: number | undefined };

/**
 * The file, as something `importCollection` and `validateImportRows` can read.
 *
 * The format comes from the extension rather than a flag, because a flag that disagrees with the
 * file is a class of bug nobody needs: `--format csv` on a .xlsx would reach the CSV parser as a
 * wall of zip bytes and report a parse failure that names the wrong thing.
 */
export function payloadFor(file: string, opts: SheetSelection = {}): ImportPayload {
  const ext = extname(file).toLowerCase();
  if (ext === ".xlsx")
    return { format: "xlsx", bytes: new Uint8Array(readFileSync(file)), ...opts };
  if (ext === ".json") return { format: "json", text: readFileSync(file, "utf8") };
  if (ext === ".csv") return { format: "csv", text: readFileSync(file, "utf8") };
  throw new Error(
    `Cannot import "${basename(file)}" — warehousd reads .csv, .json and .xlsx. ` +
      `An .xls saved by an old Excel is a different format; re-save it as .xlsx.`,
  );
}

export function formatOf(payload: ImportPayload): ImportFormat {
  return payload.format;
}

/** Rows from a file, with the sheet reader wired in for .xlsx. */
export function rowsFrom(payload: ImportPayload): Record<string, unknown>[] {
  return parseImport(payload, { sheets: makeSheetReader() });
}

// --- validate --------------------------------------------------------------------------------

export type ValidateLayer = "static" | "live";

export type ValidateResult = {
  ok: boolean;
  /**
   * Which layer actually ran. It has to be reported, because the static layer has a
   * false-failure mode: a dataset-sourced vocabulary's terms live in env-scoped `app.terms`,
   * which a pure function cannot read, so the column comes back `unvalidatable_term`. A user who
   * read that as a plain failure would go and chase a non-problem.
   */
  layer: ValidateLayer;
  rows: number;
  collection: string;
  summary?: ImportErrorSummary | undefined;
  /** What the layer that ran is blind to, in one sentence. Null when nothing. */
  blindSpot: string | null;
};

const STATIC_BLIND_SPOT =
  "dataset-sourced vocabulary terms, upsert required-column rechecks, primary-key conflicts " +
  "against stored documents, and whether the import role can write — run again with --live";

/**
 * Two layers, and it must say which one it ran.
 *
 * | Layer  | Catches                                                                    |
 * | ------ | -------------------------------------------------------------------------- |
 * | static | unknown/missing/derived columns, ragged rows, per-cell coercion, YAML terms, |
 * |        | duplicate pks within the file                                               |
 * | live   | all of the above plus dataset-sourced terms, the upsert-vs-create required-  |
 * |        | column recheck, pk conflicts against stored documents, and write privilege   |
 *
 * The live layer is `importCollection(..., { dryRun: true })` — the real statements against the
 * real table, rolled back. It is the same code path a real import takes, which is the only kind
 * of preview worth having.
 */
export async function runImportValidate(
  projectDir: string,
  file: string,
  collection: string,
  opts: {
    live?: string | undefined;
    mode?: ImportMode;
    sheet?: string | undefined;
    headerRow?: number | undefined;
    reporter?: Reporter;
  } = {},
): Promise<ValidateResult> {
  const reporter = opts.reporter ?? silentReporter;
  const cfg = loadConfig(projectDir);
  const payload = payloadFor(file, { sheet: opts.sheet, headerRow: opts.headerRow });
  const mode = opts.mode ?? "append";

  if (!opts.live) {
    const rows = rowsFrom(payload);
    const step = reporter.step("validating", `${basename(file)} → ${collection}`);
    const r = validateImportRows(cfg, collection, rows, { mode });
    if (r.ok) {
      step.done(`${rows.length} rows`);
      return {
        ok: true,
        layer: "static",
        rows: rows.length,
        collection,
        blindSpot: STATIC_BLIND_SPOT,
      };
    }
    step.fail(`${r.summary.groups.length} problem(s)`);
    return {
      ok: false,
      layer: "static",
      rows: rows.length,
      collection,
      summary: r.summary,
      blindSpot: STATIC_BLIND_SPOT,
    };
  }

  // --live. A dry run executes every statement and then rolls the transaction back, so what it
  // reports is what would happen rather than a second guess at it.
  const pools = createPools({ app: opts.live, dev: opts.live, live: opts.live, imp: opts.live });
  try {
    const t = trackStepWith<ImportProgress>(
      reporter,
      "validating",
      `${basename(file)} → ${collection} (live)`,
      (p) => ({ done: p.done, total: p.total, label: p.phase }),
    );
    const r = await importCollection(pools, cfg, "cli", collection, payload, {
      mode,
      dryRun: true,
      // The audit row says where the import came from. A console import and a CI one are the same
      // write path and a different governance question.
      via: "cli",
      sheets: makeSheetReader(),
      onProgress: t.onProgress,
    });
    if (r.ok) {
      t.step.done(`${r.inserted + r.updated + r.deleted} rows`);
      return {
        ok: true,
        layer: "live",
        rows: r.inserted + r.updated + r.deleted,
        collection,
        blindSpot: null,
      };
    }
    t.step.fail(r.reason);
    return {
      ok: false,
      layer: "live",
      rows: 0,
      collection,
      summary: r.summary ?? summarizeImportErrors(r.errors ?? []),
      blindSpot: null,
    };
  } finally {
    await pools.end();
  }
}

export function formatValidateResult(r: ValidateResult): string {
  const layer = r.layer === "live" ? "live (dry run against the database)" : "static (no database)";
  if (r.ok) {
    const lines = [`✓ ${r.rows.toLocaleString("en-US")} rows are valid for ${r.collection}`];
    lines.push(`  checked: ${layer}`);
    if (r.blindSpot) lines.push(`  not checked: ${r.blindSpot}`);
    return lines.join("\n");
  }
  const lines = [r.summary ? formatImportReport(r.summary) : `✗ ${r.collection}: import refused`];
  lines.push("", `  checked: ${layer}`);
  if (r.blindSpot) lines.push(`  not checked: ${r.blindSpot}`);
  return lines.join("\n");
}

// --- run -------------------------------------------------------------------------------------

export async function runImportRun(
  projectDir: string,
  dbUrl: string,
  collection: string,
  file: string,
  opts: {
    mode?: ImportMode;
    dryRun?: boolean;
    sheet?: string | undefined;
    headerRow?: number | undefined;
    reporter?: Reporter;
  } = {},
) {
  const reporter = opts.reporter ?? silentReporter;
  const cfg = loadConfig(projectDir);
  const payload = payloadFor(file, { sheet: opts.sheet, headerRow: opts.headerRow });
  const pools = createPools({ app: dbUrl, dev: dbUrl, live: dbUrl, imp: dbUrl });
  try {
    const t = trackStepWith<ImportProgress>(
      reporter,
      opts.dryRun ? "previewing" : "importing",
      `${basename(file)} → ${collection}`,
      (p) => ({ done: p.done, total: p.total, label: p.phase }),
    );
    const r = await importCollection(pools, cfg, "cli", collection, payload, {
      mode: opts.mode ?? "append",
      dryRun: opts.dryRun ?? false,
      via: "cli",
      sheets: makeSheetReader(),
      onProgress: t.onProgress,
    });
    if (r.ok) t.step.done(`${r.inserted} added, ${r.updated} revised, ${r.deleted} deleted`);
    else t.step.fail(r.reason);
    return r;
  } finally {
    await pools.end();
  }
}

// --- map -------------------------------------------------------------------------------------

export type MapResult =
  | { kind: "collection"; inferred: InferredCollection; yaml: string }
  | { kind: "mapping"; mapping: InferredMapping; yaml: string };

/**
 * Propose a collection block, or a column mapping for one that exists. Prints to stdout; never
 * writes `warehousd.yml`.
 *
 * The dev confirms. That is not timidity about editing a file — it is the same rule §P4 states
 * about the whole catalogue: warehousd's credibility rests on the config being a reviewed
 * artefact in git, and a tool that edits it turns the file into a cache of what a tool guessed.
 */
export function runImportMap(
  projectDir: string,
  file: string,
  opts: { collection?: string; sheet?: string | undefined; headerRow?: number | undefined } = {},
): MapResult {
  const cfg = loadConfig(projectDir);
  const payload = payloadFor(file, { sheet: opts.sheet, headerRow: opts.headerRow });
  const rows = rowsFrom(payload);
  if (rows.length === 0) throw new Error(`"${basename(file)}" has no data rows`);

  const name = opts.collection ?? defaultCollectionName(file);
  const existing = cfg.collections[name];
  if (existing) {
    const mapping = inferMapping(name, existing, Object.keys(rows[0]!));
    return { kind: "mapping", mapping, yaml: renderMappingYaml(mapping) };
  }
  const inferred = inferCollection(name, rows);
  return { kind: "collection", inferred, yaml: renderCollectionYaml(inferred) };
}

/** `./people.xlsx` → `people`, which is what a collection is nearly always called. */
export function defaultCollectionName(file: string): string {
  const stem = basename(file, extname(file));
  return stem
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function formatMapResult(r: MapResult): string {
  const out: string[] = [];
  if (r.kind === "collection") {
    const closed = r.inferred.fields.filter((f) => f.closedBecause);
    out.push(
      `# Proposed from ${r.inferred.sampled} row(s). This is a STARTING POINT — read every line.`,
      `# Nothing has been written. Paste this into warehousd.yml, correct it, then \`warehousd apply\`.`,
      "",
      r.yaml,
    );
    if (closed.length) {
      out.push("", `Closed by default (${closed.length}):`);
      for (const f of closed) out.push(`  ${f.field.padEnd(24)} ${f.closedBecause}`);
      out.push(
        "",
        "  Deny-by-default is a guess about the name, not a reading of the data. Open what",
        "  should be open, and check what it left open.",
      );
    }
    return out.join("\n");
  }

  const m = r.mapping;
  if (r.yaml) {
    out.push(
      `# ${Object.keys(m.columns).length} header(s) need mapping. Paste into warehousd.yml, then \`warehousd apply\`.`,
      "",
      r.yaml,
    );
  } else {
    out.push(`Every header already matches a field on ${m.collection}. No mapping needed.`);
  }
  if (m.unmatchedHeaders.length) {
    out.push("", `Headers with no field (${m.unmatchedHeaders.length}):`);
    for (const h of m.unmatchedHeaders) out.push(`  ${h}`);
    out.push("  Add the field to the collection, or drop the column from the sheet.");
  }
  if (m.missingRequired.length) {
    out.push("", `Required fields with no header (${m.missingRequired.length}):`);
    for (const f of m.missingRequired) out.push(`  ${f}`);
    out.push("  An `append` will refuse the file until each has a column, or is `nullable: true`.");
  }
  return out.join("\n");
}

/** Reserved for the taxonomy pre-resolution `--live` needs; kept here so both layers agree. */
export async function liveTaxonomies(dbUrl: string, cfg: WarehousdConfig, collection: string) {
  const db = new Pool({ connectionString: dbUrl });
  try {
    return await loadTaxonomyBindings(db, cfg, collection, "live");
  } finally {
    await db.end();
  }
}
