// Migration 0010 — scope app.terms to a workspace.
//
// A dataset-sourced vocabulary's terms are materialised FROM tenant rows (syncDatasetTerms
// selects distinct values out of data_synth/data_live). Without a workspace column, that made
// every workspace's term picker and describeCollection list every OTHER workspace's client
// numbers, names, or whatever column the vocabulary sources from — a straight data leak across
// the tenant boundary PR 0-2 exist to build. See docs/architecture.md, "Taxonomies".
export const m0010TermsWorkspace = {
  version: "0010_terms_workspace",
  sql: `
alter table app.terms add column if not exists workspace_id text not null default '*';
-- '*' = declared in warehousd.yml, therefore deployment-global (every workspace sees the same
-- YAML-sourced terms). A real id = derived from one workspace's own rows, visible only there.
-- Two meanings, one column, and '*' is not a valid workspace id (app.workspaces.id never is),
-- so the two can never collide.
alter table app.terms drop constraint if exists terms_vocabulary_id_env_slug_key;
create unique index if not exists terms_scope_idx
  on app.terms (vocabulary_id, env, workspace_id, slug);
`,
};
