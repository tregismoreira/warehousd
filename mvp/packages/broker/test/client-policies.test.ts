import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { getClientPolicy, setAllowedScopes, hasApprovedLiveGrant, upsertClientPolicy } from "../src/oauth/client-policies";

let p: Provisioned, admin: Pool;
beforeAll(async () => {
  p = await provision("clientpolicies"); admin = new Pool({ connectionString: p.urls.admin });
  await admin.query(`create table if not exists app."oauthApplication" ("clientId" text primary key)`);
  await createAppSchema(admin);
});
afterAll(async () => { await admin.end(); await p.end(); });

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
  const r = await admin.query(`select allowed_scopes, promoted_by, promoted_at from app.client_policies where client_id='c1'`);
  expect(r.rows[0].allowed_scopes.sort()).toEqual(["env:dev", "env:live"]);
  expect(r.rows[0].promoted_by).toBe("ana");
  expect(r.rows[0].promoted_at).not.toBeNull();
});

it("hasApprovedLiveGrant: true only for approved, env=live, unexpired grants", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u1','people',array['id'],'live','approved', now() + interval '1 day')`);
  expect(await hasApprovedLiveGrant(admin, "u1")).toBe(true);
});

it("hasApprovedLiveGrant: false when the only approved live grant has NULL expires_at (spec-literal rule 2)", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u2','people',array['id'],'live','approved', null)`);
  expect(await hasApprovedLiveGrant(admin, "u2")).toBe(false);
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
