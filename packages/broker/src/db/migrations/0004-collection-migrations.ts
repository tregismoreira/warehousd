import type { Migration } from "./index";

// The ledger for project-authored migrations — the SQL files in <project>/migrations/ that unblock
// a destructive collection change. Separate from app.schema_migrations on purpose: that one tracks
// migrations shipped in this repository, whose contents cannot change under a running database.
//
// These can. They are written by an operator, live in their project, and are editable after the
// fact — so the checksum is stored too, and a file that changed after it was applied is a refusal
// rather than a silent skip.
export const m0004CollectionMigrations: Migration = {
  version: "0004-collection-migrations",
  sql: `
    create table if not exists app.collection_migrations (
      version     text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now());
  `,
};
