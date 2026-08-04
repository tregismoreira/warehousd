import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import {
  getClientPolicy,
  setAllowedScopes,
  hasApprovedLiveGrant,
  upsertClientPolicy,
  setCanManageAcl,
} from "../src/oauth/client-policies";

let p: Provisioned, admin: Pool;
beforeAll(async () => {
  p = await provision("clientpolicies");
  admin = new Pool({ connectionString: p.urls.admin });
  await admin.query(
    `create table if not exists app."oauthApplication" ("clientId" text primary key)`,
  );
  await createAppSchema(admin);
});
afterAll(async () => {
  await admin.end();
  await p.end();
});

beforeEach(async () => {
  await admin.query(`delete from app.client_policies`);
  await admin.query(`delete from app.grants`);
  await admin.query(`delete from app."oauthApplication"`);
});

it("missing policy row resolves to {env:dev}, never allow-all", async () => {
  const policy = await getClientPolicy(admin, "unknown-client");
  expect(policy.allowedScopes).toEqual(["env:dev"]);
});

it("upsertClientPolicy creates a row with the given scopes", async () => {
  await admin.query(`insert into app."oauthApplication" ("clientId") values ('c1')`);
  await upsertClientPolicy(admin, "c1", "Test Client", ["env:dev", "env:live"]);
  const policy = await getClientPolicy(admin, "c1");
  expect(policy.allowedScopes.sort()).toEqual(["env:dev", "env:live"]);
});

it("setAllowedScopes updates an existing row and stamps promoted_at/by", async () => {
  await admin.query(`insert into app."oauthApplication" ("clientId") values ('c1')`);
  await upsertClientPolicy(admin, "c1", "Test Client", ["env:dev"]);
  await setAllowedScopes(admin, "c1", ["env:dev", "env:live"], "ana");
  const r = await admin.query(
    `select allowed_scopes, promoted_by, promoted_at from app.client_policies where client_id='c1'`,
  );
  expect(r.rows[0].allowed_scopes.sort()).toEqual(["env:dev", "env:live"]);
  expect(r.rows[0].promoted_by).toBe("ana");
  expect(r.rows[0].promoted_at).not.toBeNull();
});

// `can_manage_acl` decides who may change WHO can read a document, so the closed default matters
// as much as the setter does — an unregistered client and a freshly created one must both read
// false, or the flag would be acquired by omission rather than by decision.
it("can_manage_acl defaults to false, for a missing row and for a new one alike", async () => {
  expect((await getClientPolicy(admin, "unknown-client")).canManageAcl).toBe(false);
  await admin.query(`insert into app."oauthApplication" ("clientId") values ('c1')`);
  await upsertClientPolicy(admin, "c1", "Test Client", ["env:dev"]);
  expect((await getClientPolicy(admin, "c1")).canManageAcl).toBe(false);
});

it("setCanManageAcl grants and withdraws it, and reports an unknown client", async () => {
  await admin.query(`insert into app."oauthApplication" ("clientId") values ('c1')`);
  await upsertClientPolicy(admin, "c1", "Test Client", ["env:dev"]);

  expect(await setCanManageAcl(admin, "c1", true)).toBe(true);
  expect((await getClientPolicy(admin, "c1")).canManageAcl).toBe(true);
  // Withdrawing is the same call, so the two cannot drift.
  expect(await setCanManageAcl(admin, "c1", false)).toBe(true);
  expect((await getClientPolicy(admin, "c1")).canManageAcl).toBe(false);

  // No row updated is reported rather than swallowed: the console turns it into a 404 instead of
  // telling an admin a client they mistyped was changed.
  expect(await setCanManageAcl(admin, "never-registered", true)).toBe(false);
});

// Granting ACL management must not widen the environment a client reaches, and promoting a client
// to live must not hand it ACL management. They are separate axes and one request sets one.
it("the ACL flag and the env scope are independent", async () => {
  await admin.query(`insert into app."oauthApplication" ("clientId") values ('c1')`);
  await upsertClientPolicy(admin, "c1", "Test Client", ["env:dev"]);
  await setCanManageAcl(admin, "c1", true);
  expect((await getClientPolicy(admin, "c1")).allowedScopes).toEqual(["env:dev"]);

  await setAllowedScopes(admin, "c1", ["env:dev", "env:live"], "ana");
  expect((await getClientPolicy(admin, "c1")).canManageAcl).toBe(true);
});

it("hasApprovedLiveGrant: true only for approved, env=live, unexpired grants", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u1','people',array['id'],'live','approved', now() + interval '1 day')`);
  expect(await hasApprovedLiveGrant(admin, "u1")).toBe(true);
});

it("hasApprovedLiveGrant: true when the only approved live grant has NULL expires_at (no expiry = never expires)", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u2','people',array['id'],'live','approved', null)`);
  expect(await hasApprovedLiveGrant(admin, "u2")).toBe(true);
});

it("hasApprovedLiveGrant: false when the grant is expired", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u3','people',array['id'],'live','approved', now() - interval '1 day')`);
  expect(await hasApprovedLiveGrant(admin, "u3")).toBe(false);
});

it("hasApprovedLiveGrant: false for a dev-env grant even if approved and unexpired", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u4','people',array['id'],'dev','approved', now() + interval '1 day')`);
  expect(await hasApprovedLiveGrant(admin, "u4")).toBe(false);
});
