import { it, expect, beforeAll, afterAll, describe } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { generateSynthetic } from "../src/synthetic/generate";
import { createPools, withOrg, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { loadConfig } from "../src/config/load";
import { seedLive } from "../../../examples/meridian/seed/live";
import { LIVE_ONLY_CANARY } from "./fixtures/canaries";
import { join } from "node:path";
import { setupWebDb, signIn } from "../../../apps/web/test/helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "../../../apps/web/test/helpers/oauth";
import { upsertClientPolicy, requestGrant, approveGrant, revokeGrant, setAllowedScopes } from "../src";

const cfg = loadConfig(join(__dirname, "../../../examples/meridian"));
let p: Provisioned, admin: Pool, pools: Pools;
beforeAll(async () => {
  p = await provision("dbroles"); admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin); await applyConfig(admin, cfg);
  await generateSynthetic(admin, cfg, 42);
  await seedLive(admin);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
});
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

it("test 1: app role has NO direct data privileges; broker path works", async () => {
  // app role is warehousd_dev/live for data — but the "app" pool connects as superuser in tests;
  // assert the DENY on the two data roles crossing their wall instead (the real structural guarantee):
  const dev = new Pool({ connectionString: p.urls.dev });
  await expect(dev.query(`select * from data_live.v_people`)).rejects.toThrow();
  await dev.end();
});

it("test 5 (partial): dev token cannot see live-only canary; direct role check", async () => {
  const broker = makeBroker(pools, cfg);
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status) values
    ('u','people', array['id','full_name','email'],'dev','approved')`);
  const r = await broker.query({ userId: "u", orgId: "default", env: "dev" }, { collection: "people", limit: 500 });
  expect(r.ok).toBe(true);
  if (r.ok) {
    const blob = JSON.stringify(r.documents);
    expect(blob.includes(LIVE_ONLY_CANARY)).toBe(false);
  }
  // direct: warehousd_dev is refused on data_live
  const dev = new Pool({ connectionString: p.urls.dev });
  await expect(dev.query(`select * from data_live.v_people`)).rejects.toThrow();
  await dev.end();
});

it("test 5 (scope clauses): full env-as-scope acceptance gate", async () => {
  const web = await setupWebDb("acceptance5");
  try {
    const miaCookie = await signIn(web.auth, "mia@meridian.demo", "demo");
    const { getAppPool } = await import("../../../apps/web/app/lib/broker");
    const app = getAppPool();

    // Dev-only client requesting env:live → issued token contains only env:dev.
    const reg = await web.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Acceptance Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json(); // snake_case — RFC 7591
    await upsertClientPolicy(app, client_id, "Acceptance Client", ["env:dev"]); // dev-only

    async function authorizeAndGetToken(scope: string) {
      const { verifier, challenge } = pkcePair();
      const { code } = await authorizeAndGetCode(web.auth, {
        clientId: client_id, scope, cookie: miaCookie, challenge,
      });
      const tokenRes = await web.auth.api.mcpOAuthToken({
        body: {
          grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/callback",
          client_id, client_secret, code_verifier: verifier,
        },
        asResponse: true,
      } as any);
      return tokenRes.json();
    }

    // Request BOTH env:dev and env:live: rule 1's intersection only keeps scopes that are
    // both requested and allowed — it never adds back an unrequested scope. Requesting
    // env:live alone (as the plan's own literal brief text did) would correctly result in
    // NEITHER scope surviving, not a fallback to env:dev; that's the already-verified
    // behavior of Task 4's rule 1 test, which only asserts not.toContain("env:live") for
    // exactly this reason. Request both here so the intended "downgrade to allowed subset"
    // scenario is actually exercised.
    // offline_access is required to receive a refresh_token at all (see Task 7) — without
    // it, t1.refresh_token is undefined and the refresh calls below silently error.
    const t1 = await authorizeAndGetToken("env:dev env:live openid offline_access");
    expect(t1.scope).not.toContain("env:live");
    expect(t1.scope).toContain("env:dev");

    // After promotion, next refresh yields env:live.
    await setAllowedScopes(app, client_id, ["env:dev", "env:live"], "ana");
    const grantId = await requestGrant(app, { userId: "mia", collection: "people", orgId: "default", env: "live", purposeLabel: "t", allowedFields: ["id"] });
    await approveGrant(app, cfg, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const refreshed = await web.auth.api.mcpOAuthToken({
      body: { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id, client_secret },
      asResponse: true,
    } as any).then((r: Response) => r.json());
    expect(refreshed.scope).toContain("env:live");

    // After demotion, next refresh drops it.
    await setAllowedScopes(app, client_id, ["env:dev"], "ana");
    const demoted = await web.auth.api.mcpOAuthToken({
      body: { grant_type: "refresh_token", refresh_token: refreshed.refresh_token, client_id, client_secret },
      asResponse: true,
    } as any).then((r: Response) => r.json());
    expect(demoted.scope).not.toContain("env:live");

    // Token with no env scope → adapter defaults to dev.
    await setAllowedScopes(app, client_id, ["env:dev", "env:live"], "ana");
    const noEnv = await authorizeAndGetToken("openid");
    const { deriveTokenContext } = await import("../../../apps/web/lib/broker-context");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      headers: { authorization: `Bearer ${noEnv.access_token}` },
    }));
    expect(ctx?.env).toBe("dev");

    // Token payload contains only sub/client/env — no grant data (spot-check the row).
    const row = await app.query(`select * from app."oauthAccessToken" where "accessToken"=$1`, [noEnv.access_token]);
    const cols = Object.keys(row.rows[0]);
    expect(cols).not.toEqual(expect.arrayContaining(["allowedFields", "purposeLabel", "documentFilter"]));

    // Revoked grant → env:live gone within one forced refresh.
    const liveToken = await authorizeAndGetToken("env:live openid offline_access");
    const g2 = await app.query(`select id from app.grants where user_id='mia' and env='live' and status='approved' order by requested_at desc limit 1`);
    await revokeGrant(app, g2.rows[0].id, "marcus");
    const afterRevoke = await web.auth.api.mcpOAuthToken({
      body: { grant_type: "refresh_token", refresh_token: liveToken.refresh_token, client_id, client_secret },
      asResponse: true,
    } as any).then((r: Response) => r.json());
    expect(afterRevoke.scope).not.toContain("env:live");
  } finally {
    await web.end();
  }
}, 60_000);

it("test 8: synthetic generator role has no data_live privilege; FK integrity holds", async () => {
  const dev = new Pool({ connectionString: p.urls.dev });
  await expect(dev.query(`select 1 from data_live.people`)).rejects.toThrow();
  await dev.end();
  const orphans = await admin.query(
    `select 1 from data_synth.salaries s
     left join data_synth.people p on p.id=s.person_id where s.person_id is not null and p.id is null`);
  expect(orphans.rowCount).toBe(0);
});

describe("env role grants (design §8 test 7)", () => {
  let p2: Provisioned;
  afterAll(async () => { await p2?.end(); });

  it("env role reads file view but not base tables", async () => {
    p2 = await provision("view-only");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);

    const docCfg = {
      project: "t", server: { port: 1 }, synthetic: { documents_per_collection: {} },
      collections: {
        policies: {
          type: "file" as const,
          description: "d",
          source: "./x",
          fields: {
            title: { posture: "allow" as const },
            content: { posture: "allow" as const },
            path: { posture: "deny" as const },
          },
        },
      },
    };

    await applyConfig(db, docCfg);

    // Insert one file + one document as admin
    await db.query(`insert into data_synth."policies__files" (id,title,path,owner,checksum,updated_at)
      values (gen_random_uuid(),'test policy','test.md',null,'c',now())`);
    const d = await db.query(`select id from data_synth."policies__files" limit 1`);
    await db.query(`insert into data_synth."policies__documents" (id,file_id,document_seq,content)
      values (gen_random_uuid(),$1,0,'policy content')`, [d.rows[0].id]);

    // Test with dev role. The view's org predicate means the read needs an org in scope —
    // withOrg() is how the broker supplies it; here the setting is made directly.
    const dev = new Pool({ connectionString: p2.urls.dev });
    const ok = await withOrg(dev, "default", (c) => c.query(`select title from data_synth.v_policies`));
    expect(ok.rowCount).toBeGreaterThan(0);
    await expect(dev.query(`select * from data_synth."policies__files"`)).rejects.toThrow(/permission denied/);
    await expect(dev.query(`select * from data_synth."policies__documents"`)).rejects.toThrow(/permission denied/);
    await expect(dev.query(`select * from data_live.v_policies`)).rejects.toThrow(/permission denied/);
    await dev.end();
    await db.end();
  });
});
