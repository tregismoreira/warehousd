// Migration 0006 — per-document ACLs: who the caller *is*, what a decision recorded them as, and
// which client may edit an ACL at all.
//
// The ACL rows themselves are NOT here. They live in the data schemas (`data_synth."_acl"` /
// `data_live."_acl"`, emitted by apply/ddl.ts) because the app pool holds no data-schema
// privileges and the read pools hold none on `app` — an ACL in `app` could not be joined into a
// collection's view at all, which is the one place the rule has to be enforced.
//
// `app.user_groups` is warehousd's own record of who is in which group. It is never read from a
// token and never taken from a caller's claim set: invariant 1 says the broker is the trust
// boundary, and a per-document deny that depends on an assertion minted outside it is not a deny.
// This is the same argument grants/eval.ts already makes for refusing to bake grants into tokens.
//
// `source` separates the two ways a row arrives. An SSO login replaces the rows it owns
// (`source='sso'`) and leaves console-managed ones (`source='manual'`) alone, so re-syncing an
// IdP cannot silently drop membership somebody granted by hand. It is part of the primary key
// rather than a plain column because the same group may legitimately be asserted by the IdP *and*
// pinned manually, and collapsing those would make removing one remove both.
//
// `app.sso_provisioned` is the marker that keeps role provisioning a first-login act while group
// membership syncs on every login. Better Auth's sso plugin hands `provisionUser` no "is this a
// registration?" flag, so without a marker the only way to sync groups per login is to re-derive
// the role per login — which would silently undo an admin's promotion in the console. See
// apps/web/lib/sso.ts.
//
// `audit_events.principals` records the membership a decision was made under. Reproducing "who
// could read page 742 on the 4th" needs membership AS IT WAS; `app.user_groups` only ever holds
// current state. Same reasoning as `unmasked_fields` in migration 0005: it is a property of the
// DECISION, not of what the caller asked for.
//
// `client_policies.can_manage_acl` defaults false. Managing an ACL is not a grant verb — a grant
// says what a caller may read, and widening who may read something is a different act — so it is
// authorised here, per client, and nothing acquires it by default.
export const m0006DocumentAcl = {
  version: "0006_document_acl",
  sql: `
create table if not exists app.user_groups (
  org_id     text not null references app.organizations(id),
  user_id    text not null,
  group_name text not null,
  source     text not null check (source in ('sso','manual')),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id, group_name, source));
create index if not exists user_groups_member_idx on app.user_groups (org_id, user_id);

create table if not exists app.sso_provisioned (
  user_id     text not null,
  provider_id text not null,
  at          timestamptz not null default now(),
  primary key (user_id, provider_id));

alter table app.audit_events
  add column if not exists principals text[] not null default '{}';

alter table app.client_policies
  add column if not exists can_manage_acl boolean not null default false;
`,
};
