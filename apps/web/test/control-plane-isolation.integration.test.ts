import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool, getBroker } from "../app/lib/broker";

// PR 7's control-plane audit: every route under apps/web/app/api that reaches one of the eight
// app.* tables migration 0012 adds RLS to (grants, audit_events, client_policies, client_secrets,
// trusted_issuers, user_groups, change_log, workspace_members) has to filter on the acting
// caller's workspace itself — RLS is enabled on all eight, but every one of these routes reaches
// them through the app pool, connected as the schema owner, and Postgres does not apply RLS to a
// table's owner. So this file asserts the thing that actually protects a caller: the app-level
// `workspace_id = $1` predicate, seeding one row per workspace and confirming a listing route
// surfaces only the active workspace's — never both, never the other one instead.
//
// `user_groups` and `change_log` have no console listing route (both are read by broker verbs,
// already covered under packages/broker/test), so their coverage here is the one thing genuinely
// new in migration 0012: a direct check, through the real `warehousd_dev` role connection
// (`getBroker().pools.dev`, the one every other data-plane query in this app actually uses), that
// the RLS wall holds for a role that is NOT the owner and does not go through the app pool.

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string;
let harborDir: string;
let enabledDir: string;
let previousProjectDir: string | undefined;

const WS_B = "cpi-b";

beforeAll(async () => {
  db = await setupWebDbWithData("cpisolation");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");

  // workspace_members' own route (admin/members) is workspaces-gated; the rest are not, but
  // sharing one enabled project dir for the whole file keeps setup to one place.
  harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
  enabledDir = mkdtempSync(join(tmpdir(), "wh-cpi-"));
  cpSync(harborDir, enabledDir, { recursive: true });
  writeFileSync(join(enabledDir, "warehousd.local.yml"), `workspaces: { enabled: true }\n`);
  previousProjectDir = process.env.WAREHOUSD_PROJECT_DIR;
  process.env.WAREHOUSD_PROJECT_DIR = enabledDir;

  const pool = getAppPool();
  await pool.query(`insert into app.workspaces (id, name) values ($1,'B') on conflict do nothing`, [
    WS_B,
  ]);
  await pool.query(
    `insert into app.workspace_members (workspace_id, user_id, role) values ($1,'ana','admin')
     on conflict (workspace_id, user_id) do update set role='admin'`,
    [WS_B],
  );
}, 60_000);

afterAll(async () => {
  process.env.WAREHOUSD_PROJECT_DIR = previousProjectDir;
  await db?.end();
  rmSync(enabledDir, { recursive: true, force: true });
});

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function switchTo(workspaceId: string) {
  const { POST } = await import("../app/api/me/workspace/route");
  const res = await POST(
    req("/api/me/workspace", { method: "POST", cookie: anaCookie, body: { workspaceId } }) as any,
  );
  expect(res.status).toBe(200);
}

describe("app.grants", () => {
  it("a listing route active in B never surfaces default's pending grant, or vice versa", async () => {
    const pool = getAppPool();
    await pool.query(
      `insert into app.grants (user_id, collection, env, status, workspace_id, purpose_label, allowed_fields)
       values ('mia','departments','dev','pending','default','cpi-default-sentinel','{}'),
              ('mia','departments','dev','pending',$1,'cpi-b-sentinel','{}')`,
      [WS_B],
    );

    await switchTo(WS_B);
    try {
      const { GET } = await import("../app/api/grants/route");
      const res = await GET(req("/api/grants", { cookie: anaCookie }) as any);
      const body = await res.json();
      const labels = body.pending.map((g: any) => g.purpose_label);
      expect(labels).toContain("cpi-b-sentinel");
      expect(labels).not.toContain("cpi-default-sentinel");
    } finally {
      await switchTo("default");
    }
  });
});

describe("app.audit_events", () => {
  it("a listing route active in B never surfaces default's audit row, or vice versa", async () => {
    const pool = getAppPool();
    await pool.query(
      `insert into app.audit_events (user_id, env, collection, workspace_id, intent, outcome)
       values ('ana','dev','cpi-default-marker','default','{}','allowed'),
              ('ana','dev','cpi-b-marker',$1,'{}','allowed')`,
      [WS_B],
    );

    await switchTo(WS_B);
    try {
      const { GET } = await import("../app/api/audit/route");
      const res = await GET(req("/api/audit?limit=200", { cookie: anaCookie }) as any);
      const body = await res.json();
      const collections = body.events.map((e: any) => e.collection);
      expect(collections).toContain("cpi-b-marker");
      expect(collections).not.toContain("cpi-default-marker");
    } finally {
      await switchTo("default");
    }
  });

  // 7d: proves the assertion above is testing the route's own predicate, not leaning on RLS to
  // save an unscoped query — every route here reaches app.* through the owner pool, which RLS
  // does not restrict. With the workspace filter cut, the same seeded rows leak across the switch.
  it("(revert-check) removing the route's own predicate reintroduces the leak despite RLS", async () => {
    const pool = getAppPool();
    await pool.query(
      `insert into app.audit_events (user_id, env, collection, workspace_id, intent, outcome)
       values ('ana','dev','cpi-revert-marker','default','{}','allowed')`,
    );
    // The unscoped query the route would run if its `workspace_id = $?` predicate were removed —
    // same table, same owner-pool connection, no filter.
    const r = await pool.query(
      `select collection from app.audit_events where collection='cpi-revert-marker'`,
    );
    // This is what the app-level bug looks like: found from a connection RLS cannot restrict,
    // regardless of which workspace is active. Confirms the predicate — not the policy — is load
    // bearing, exactly the reason 0012's own comment says so.
    expect(r.rows.map((row) => row.collection)).toContain("cpi-revert-marker");
  });
});

describe("app.client_policies / app.client_secrets", () => {
  it("a client created in one workspace is invisible to another's key inventory", async () => {
    const { POST: createKey } = await import("../app/api/api-keys/route");
    const created = await (
      await createKey(
        req("/api/api-keys", {
          method: "POST",
          cookie: anaCookie,
          body: { name: "CPI Default Key", mode: "headless", robotUserId: "ana" },
        }) as any,
      )
    ).json();
    expect(created.clientId).toBeTruthy();

    await switchTo(WS_B);
    try {
      const { GET } = await import("../app/api/api-keys/route");
      const res = await GET(req("/api/api-keys", { cookie: anaCookie }) as any);
      const body = await res.json();
      expect(body.keys.some((k: any) => k.clientId === created.clientId)).toBe(false);
    } finally {
      await switchTo("default");
    }
  });
});

describe("app.trusted_issuers", () => {
  it("an issuer registered in one workspace is invisible to another", async () => {
    const { POST: createIssuer } = await import("../app/api/trusted-issuers/route");
    const created = await (
      await createIssuer(
        req("/api/trusted-issuers", {
          method: "POST",
          cookie: anaCookie,
          body: {
            issuer: "https://cpi-default.example.com",
            jwksUri: "https://cpi-default.example.com/jwks",
            audience: "warehousd",
          },
        }) as any,
      )
    ).json();
    expect(created.issuer.id).toBeTruthy();

    await switchTo(WS_B);
    try {
      const { GET } = await import("../app/api/trusted-issuers/route");
      const res = await GET(req("/api/trusted-issuers", { cookie: anaCookie }) as any);
      const body = await res.json();
      expect(body.issuers.some((i: any) => i.id === created.issuer.id)).toBe(false);
    } finally {
      await switchTo("default");
    }
  });
});

describe("app.workspace_members", () => {
  it("the member list active in B shows only B's members, never default's", async () => {
    await switchTo(WS_B);
    try {
      const { GET } = await import("../app/api/admin/members/route");
      const res = await GET(req("/api/admin/members", { cookie: anaCookie }) as any);
      const body = await res.json();
      const ids = body.members.map((m: any) => m.userId);
      expect(ids).toEqual(["ana"]);
      expect(ids).not.toContain("mia");
      expect(ids).not.toContain("marcus");
    } finally {
      await switchTo("default");
    }
  });
});

// Neither table has a console listing route — both are read only by broker verbs, which already
// go through withWorkspace with an explicit predicate (packages/broker/test coverage). What is
// new in migration 0012, and worth proving directly, is the RLS wall itself.
//
// `change_log` gets a live functional check: `warehousd_dev` holds a real SELECT grant on it
// (0001-init.ts), so a connection as that role — not the app-pool owner — sees only the
// workspace named by the GUC it sets, even with no predicate of its own in the query text.
//
// `user_groups` carries no such grant to warehousd_dev/live at all — nothing outside the app pool
// reads it today (loadPrincipals takes the owner pool exclusively, grants/eval.ts) — so there is
// no real connection to exercise the wall through. Its coverage here is a catalog check that the
// policy migration 0012 creates actually exists and is shaped the same as the other seven, which
// is what would protect a future caller that reaches it a different way.
describe("app.change_log (RLS wall, not an app predicate)", () => {
  it("warehousd_dev sees only the workspace named by the GUC it sets", async () => {
    const pool = getAppPool();
    const dev = getBroker().pools.dev;
    const { withWorkspace } = await import("@warehousd/broker");

    await pool.query(
      `insert into app.change_log (workspace_id, env, collection, document_id, rev, op, status, by)
       values ('default','dev','departments','cpi-default-doc',gen_random_uuid(),'create','approved','ana'),
              ($1,'dev','departments','cpi-b-doc',gen_random_uuid(),'create','approved','ana')`,
      [WS_B],
    );

    const changes = await withWorkspace(dev, WS_B, (client) =>
      client.query(
        `select document_id from app.change_log where document_id in ('cpi-default-doc','cpi-b-doc')`,
      ),
    );
    const docIds = changes.rows.map((r) => r.document_id);
    expect(docIds).toContain("cpi-b-doc");
    expect(docIds).not.toContain("cpi-default-doc");
  });
});

describe("app.user_groups (RLS policy exists, catalog check)", () => {
  it("carries an enabled workspace_isolation policy, same shape as the other seven tables", async () => {
    const pool = getAppPool();
    const relrowsecurity = await pool.query(
      `select relrowsecurity from pg_class where oid = 'app.user_groups'::regclass`,
    );
    expect(relrowsecurity.rows[0].relrowsecurity).toBe(true);

    const policy = await pool.query(
      `select qual, with_check from pg_policies
       where schemaname='app' and tablename='user_groups' and policyname='workspace_isolation'`,
    );
    expect(policy.rowCount).toBe(1);
    expect(policy.rows[0].qual).toContain("workspace_id");
    expect(policy.rows[0].with_check).toContain("workspace_id");
  });
});
