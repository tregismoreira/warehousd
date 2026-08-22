// Migration 0007 — grants resolve through a PRINCIPAL, not only a user id.
//
// `app.grants` was keyed on `user_id`, so access was O(users × collections) rows, each one an
// individual manager decision. Onboarding a paralegal meant re-approving everything the last
// paralegal had; offboarding meant finding every row; "Litigation can read matters" was not
// expressible at all. `app.user_groups` and `group:` principals already existed — but only for
// per-document ACLs, and no grant was ever resolved through one.
//
// The column carries the same namespaced spelling ACLs use (`user:<id>` / `group:<name>`, see
// acl/principals.ts), because a group named the same as a user id must not silently grant that
// user's access, and one spelling means the ACL evaluator and the grant loader cannot disagree.
//
// `user_id` stays. It is still who REQUESTED the grant — which is a different question from who
// the grant is for, and the answer the manager inbox, the self-approval rule and the audit trail
// all need. On a personal grant the two agree by construction; on a group grant `user_id` is the
// person who asked for the group to be given access.
export const m0007GrantPrincipal = {
  version: "0007_grant_principal",
  sql: `
alter table app."grants" add column if not exists principal text;

-- Every existing grant is a personal one, so its principal is its requester. Backfilled rather
-- than defaulted, because the default would then apply to a row whose principal was genuinely
-- meant to be a group and nobody set it.
update app."grants" set principal = 'user:' || user_id where principal is null;

-- Filled in from user_id when a writer does not supply one.
--
-- A trigger rather than a column default, because a default cannot reference another column — and
-- rather than "every caller must remember", because the whole invariant this migration adds is
-- that a grant row ALWAYS carries a namespaced principal. A seeder, an operator's psql session or
-- an adapter written before groups existed all insert a personal grant and mean it; making them
-- say so twice is the kind of requirement that gets forgotten exactly once.
create or replace function app.grants_default_principal() returns trigger as $fn$
begin
  if new.principal is null then new.principal := 'user:' || new.user_id; end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists grants_default_principal on app."grants";
create trigger grants_default_principal
  before insert on app."grants"
  for each row execute function app.grants_default_principal();

alter table app."grants" alter column principal set not null;

-- The namespace is the whole point: without it, "alice" is ambiguous between a user id and a
-- group name, and an approver has no way to say which they meant. Checked in the database as well
-- as in isPrincipal(), because a grant is the one row where guessing widens access.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'grants_principal_namespaced') then
    alter table app."grants" add constraint "grants_principal_namespaced"
      check (principal like 'user:_%' or principal like 'group:_%');
  end if;
end $$;

-- "One approved grant per subject per collection" now means per PRINCIPAL, not per user.
--
-- The old index was (workspace_id, user_id, collection, env), which is the same thing while
-- "user_id" is the subject. It is not: "user_id" is who REQUESTED the grant, so an admin who asks
-- for a group grant on a collection they already hold personally would collide with themselves —
-- and two group grants requested by the same admin would collide with each other, which is the
-- shape the whole feature is for.
drop index if exists app.grants_one_active;
create unique index if not exists grants_one_active_principal
  on app."grants" (workspace_id, principal, collection, env) where status = 'approved';

-- loadActiveGrant's predicate: (collection, env, workspace, principal = any(...)), filtered to
-- approved and unexpired. The status column leads because it is the most selective in practice —
-- most rows in a mature deployment are decided history rather than live access.
create index if not exists grants_principal_lookup
  on app."grants" (collection, env, workspace_id, principal)
  where status = 'approved';

-- Which grant a decision was made under is already on the audit row via grant_id. The principal is
-- recorded alongside it because a grant can be revoked, and "on what authority" has to stay
-- answerable after the row it names is gone.
alter table app."audit_events" add column if not exists grant_principal text;
`,
};
