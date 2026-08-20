import type { SchemaChange } from "./plan";

const HEADER = `-- warehousd migration
--
-- Applied once, in filename order, before applyConfig runs. applyConfig then re-derives the plan
-- from the live schema, so a migration that does not actually resolve the change still blocks the
-- boot — this file is checked by its effect, not by what it claims to do.
--
-- Nothing here runs against data_synth: synthetic data is a function of (config, seed) and is
-- regenerated on every boot, so applyConfig rebuilds those tables in place.`;

const REVIEW_OPTIONS = `--   1. Rename instead of retyping: keep the existing field and add a new one, then backfill.
--      A rename is \`alter table … rename column old to new\`, which loses nothing.
--   2. Edit the USING below so the rows that would not convert are handled explicitly.
--   3. Accept the loss and uncomment the statement as it stands.`;

/**
 * Render a reviewable migration for the destructive part of a plan.
 *
 * Three dependants have to come down before a column can be altered, and getting any of them wrong
 * is a migration that fails in production rather than on the operator's machine:
 *
 * - the collection's view selects the column, and Postgres refuses to alter a column a view uses;
 * - a `searchable` field carries a generated `<field>_tsv` column computed from it;
 * - a writable collection's `<collection>_current_idx` is built on the declared pk.
 *
 * All three are recreated by applyConfig immediately afterwards — `viewDDL` drops and recreates
 * unconditionally, and the tsv and index alters are `if not exists` — so dropping them here costs
 * nothing and is the only thing that makes the ALTER legal.
 */
export function renderMigrationSql(changes: SchemaChange[]): string {
  // `drop_index` is the one non-destructive change that still belongs in a reviewed migration:
  // it discards no data, so `apply` must not do it unasked, but it does change query plans.
  const live = changes.filter(
    (c) => (c.destructive || c.kind === "drop_index") && c.env === "live",
  );
  if (live.length === 0) return `${HEADER}\n\n-- No destructive changes to apply.\n`;

  const out: string[] = [HEADER, ""];

  // One view drop per collection, before anything that touches its columns. Driven by the
  // destructive changes alone: a dropped index needs no view out of its way, and emitting a
  // pointless drop/recreate for an index-only migration would read as a column change.
  for (const collection of [
    ...new Set(live.filter((c) => c.destructive).map((c) => c.collection)),
  ]) {
    out.push(
      `-- Recreated by applyConfig; dropped here because a view blocks ALTER on its columns.`,
      `drop view if exists data_live.v_${collection};`,
      "",
    );
  }

  for (const change of live) {
    const { collection, table, field } = change;

    if (change.kind === "drop_index") {
      out.push(
        `-- ${change.from} is no longer declared in warehousd.yml. Dropping an index discards no`,
        `-- data, but it can change query plans — review before uncommenting. CONCURRENTLY keeps`,
        `-- the collection writable while it runs, and cannot be inside a transaction block.`,
        `-- drop index concurrently if exists data_live."${change.from}";`,
        "",
      );
      continue;
    }

    if (change.kind === "drop_collection") {
      out.push(
        `-- REVIEW: collection ${collection} is gone from warehousd.yml. Dropping the table`,
        `-- discards every row in it, and there is no undo.`,
        `-- drop table if exists data_live."${table}" cascade;`,
        `-- delete from app.collections where name = '${collection}';`,
        "",
      );
      continue;
    }

    if (change.kind === "pk_change") {
      out.push(
        `-- REVIEW: ${collection} changes document identity from ${change.from} to ${change.to}.`,
        `-- Every existing revision is keyed by the old field. Confirm ${change.to} is unique per`,
        `-- document before uncommenting, or the index below will not build.`,
        `-- drop index if exists data_live."${collection}_current_idx";`,
        "",
      );
      continue;
    }

    if (change.kind === "drop_column") {
      out.push(
        `-- REVIEW: ${collection}.${field} is in the database but not in warehousd.yml.`,
        `-- If the field was renamed, do this instead and nothing is lost:`,
        `--   alter table data_live."${table}" rename column "${field}" to "<new name>";`,
        `-- To discard the column and everything in it:`,
        `-- alter table data_live."${table}" drop column if exists "${field}";`,
        "",
      );
      continue;
    }

    // type_change.
    //
    // The tsv drop is unconditional, and `if exists`. Whether a generated column stands in the way
    // is a fact about the database, not about the config being applied — a field that is losing
    // `searchable: true` in the same change still has one, and asking the new config would miss
    // exactly that case.
    const tsv = `alter table data_live."${table}" drop column if exists "${field}_tsv";`;
    const alter =
      `alter table data_live."${table}" alter column "${field}" type ${change.to} ` +
      `using ${change.using};`;

    // The tsv drop stays live even in the review branch: a generated column holds nothing that is
    // not derived, applyConfig re-adds it, and leaving it commented out is how an operator who
    // uncomments only the cast gets a migration that fails on the first row.
    out.push(`-- Rebuilt by applyConfig if the field is still searchable.`, tsv);

    if (change.reviewRequired) {
      out.push(
        `-- REVIEW: ${collection}.${field} — ${change.from} → ${change.to}. This cast can lose`,
        `-- data, and a row that will not convert aborts the whole migration. Options:`,
        REVIEW_OPTIONS,
        `-- ${alter}`,
        "",
      );
    } else {
      out.push(
        `-- ${collection}.${field} — ${change.from} → ${change.to}. Lossless; nothing to review.`,
        alter,
        "",
      );
    }
  }

  return `${out.join("\n")}\n`;
}

/** `0007-widen-amount.sql` from the versions already present and a slug. */
export function nextMigrationFilename(existing: string[], slug: string): string {
  const highest = existing.reduce((max, name) => {
    const n = Number(/^(\d+)/.exec(name)?.[1] ?? NaN);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  const safe =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "migration";
  return `${String(highest + 1).padStart(4, "0")}-${safe}.sql`;
}
