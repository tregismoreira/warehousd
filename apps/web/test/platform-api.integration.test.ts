import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWebDbWithData } from "./helpers/web-db";
import { getAppPool, getConfig } from "../app/lib/broker";
import {
  createPlatformKey,
  revokePlatformKey,
  loadConfig,
  declaredTables,
} from "@warehousd/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let harborDir: string;
let enabledDir: string;
let previousProjectDir: string | undefined;

beforeAll(async () => {
  db = await setupWebDbWithData("platformapi");
  harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
  enabledDir = mkdtempSync(join(tmpdir(), "wh-platform-api-"));
  cpSync(harborDir, enabledDir, { recursive: true });
  writeFileSync(join(enabledDir, "warehousd.local.yml"), `workspaces: { enabled: true }\n`);

  previousProjectDir = process.env.WAREHOUSD_PROJECT_DIR;
  process.env.WAREHOUSD_PROJECT_DIR = enabledDir;
}, 60_000);

afterAll(async () => {
  process.env.WAREHOUSD_PROJECT_DIR = previousProjectDir;
  await db?.end();
  rmSync(enabledDir, { recursive: true, force: true });
});

function req(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  return new Request(`http://localhost:8722${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function mintKey(managedWorkspaces: string[] | null, days = 90) {
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return createPlatformKey(getAppPool(), {
    label: "test key",
    managedWorkspaces,
    expiresAt,
    createdBy: "test",
  });
}

const auditCountForKey = async (keyId: string) =>
  Number(
    (
      await getAppPool().query(`select count(*)::int as n from app.audit_events where via = $1`, [
        `platform_key:${keyId}`,
      ])
    ).rows[0].n,
  );

describe("POST /v1/platform/workspaces", () => {
  it("creates the workspace and its first admin member; a duplicate id is 409", async () => {
    const key = await mintKey(null);
    const { POST } = await import("../app/v1/platform/workspaces/route");

    const first = await POST(
      req("/v1/platform/workspaces", {
        method: "POST",
        token: key.secret,
        body: { id: "pw1", name: "PW One", admin: { userId: "pw1-admin" } },
      }) as any,
    );
    expect(first.status).toBe(201);

    const members = await getAppPool().query(
      `select role from app.workspace_members where workspace_id='pw1'`,
    );
    expect(members.rows).toEqual([{ role: "admin" }]);

    const dup = await POST(
      req("/v1/platform/workspaces", {
        method: "POST",
        token: key.secret,
        body: { id: "pw1", name: "PW One Again", admin: { userId: "someone-else" } },
      }) as any,
    );
    expect(dup.status).toBe(409);
  });

  it("rejects an id that does not match the identifier shape", async () => {
    const key = await mintKey(null);
    const { POST } = await import("../app/v1/platform/workspaces/route");
    const res = await POST(
      req("/v1/platform/workspaces", {
        method: "POST",
        token: key.secret,
        body: { id: "Bad_Id!", name: "x", admin: { userId: "u" } },
      }) as any,
    );
    expect(res.status).toBe(400);
  });
});

describe("key scoping", () => {
  it("a key only sees, reads, and deletes the workspaces it manages", async () => {
    const key1 = await mintKey([]);
    const key2 = await mintKey([]);
    const { POST: createWorkspace } = await import("../app/v1/platform/workspaces/route");
    await createWorkspace(
      req("/v1/platform/workspaces", {
        method: "POST",
        token: key1.secret,
        body: { id: "scope-w1", name: "W1", admin: { userId: "w1-admin" } },
      }) as any,
    );
    await createWorkspace(
      req("/v1/platform/workspaces", {
        method: "POST",
        token: key2.secret,
        body: { id: "scope-w2", name: "W2", admin: { userId: "w2-admin" } },
      }) as any,
    );

    const { GET: listWorkspaces } = await import("../app/v1/platform/workspaces/route");
    const listRes = await listWorkspaces(
      req("/v1/platform/workspaces", { token: key1.secret }) as any,
    );
    const listed = (await listRes.json()).workspaces.map((w: any) => w.id);
    expect(listed).toEqual(["scope-w1"]);

    const { GET: getWorkspace, DELETE: deleteWorkspace } =
      await import("../app/v1/platform/workspaces/[id]/route");
    const getRes = await getWorkspace(
      req("/v1/platform/workspaces/scope-w2", { token: key1.secret }) as any,
      ctx("scope-w2"),
    );
    expect(getRes.status).toBe(404);

    const delRes = await deleteWorkspace(
      req("/v1/platform/workspaces/scope-w2", { method: "DELETE", token: key1.secret }) as any,
      ctx("scope-w2"),
    );
    expect(delRes.status).toBe(404);

    const survives = await getAppPool().query(`select 1 from app.workspaces where id='scope-w2'`);
    expect(survives.rowCount).toBe(1);
  });
});

describe("key lifecycle", () => {
  it("a revoked key is 401", async () => {
    const key = await mintKey(null);
    await revokePlatformKey(getAppPool(), key.id);
    const { GET } = await import("../app/v1/platform/workspaces/route");
    const res = await GET(req("/v1/platform/workspaces", { token: key.secret }) as any);
    expect(res.status).toBe(401);
  });

  it("an expired key is 401", async () => {
    const key = await mintKey(null, 1);
    await getAppPool().query(
      `update app.platform_keys set expires_at = now() - interval '1 hour' where id=$1`,
      [key.id],
    );
    const { GET } = await import("../app/v1/platform/workspaces/route");
    const res = await GET(req("/v1/platform/workspaces", { token: key.secret }) as any);
    expect(res.status).toBe(401);
  });
});

describe("the no-data-plane boundary", () => {
  it("a platform key presented to /v1/collections is 401, not authenticated", async () => {
    const key = await mintKey(null);
    const { GET } = await import("../app/v1/collections/route");
    const res = await GET(req("/v1/collections", { token: key.secret }) as any);
    expect(res.status).toBe(401);
  });

  it("a platform key presented to /mcp is 401, not authenticated", async () => {
    const key = await mintKey(null);
    const { GET } = await import("../app/mcp/route");
    const res = await GET(req("/mcp", { token: key.secret }));
    expect(res.status).toBe(401);
  });
});

describe("audit trail", () => {
  it("every platform mutation writes exactly one audit_events row, via platform_key:<id>", async () => {
    const key = await mintKey(null);
    const before = await auditCountForKey(key.id);

    const { POST: createWorkspace } = await import("../app/v1/platform/workspaces/route");
    await createWorkspace(
      req("/v1/platform/workspaces", {
        method: "POST",
        token: key.secret,
        body: { id: "audit-w1", name: "Audit W1", admin: { userId: "audit-admin" } },
      }) as any,
    );

    const { POST: addMember } = await import("../app/v1/platform/workspaces/[id]/members/route");
    await addMember(
      req("/v1/platform/workspaces/audit-w1/members", {
        method: "POST",
        token: key.secret,
        body: { userId: "audit-member", role: "member" },
      }) as any,
      ctx("audit-w1"),
    );

    const { POST: seed } = await import("../app/v1/platform/workspaces/[id]/seed/route");
    await seed(
      req("/v1/platform/workspaces/audit-w1/seed", {
        method: "POST",
        token: key.secret,
        body: { seed: 7 },
      }) as any,
      ctx("audit-w1"),
    );

    const after = await auditCountForKey(key.id);
    expect(after - before).toBe(3);

    const rows = await getAppPool().query(`select via from app.audit_events where via = $1`, [
      `platform_key:${key.id}`,
    ]);
    expect(rows.rows.every((r) => (r.via as string).startsWith("platform_key:"))).toBe(true);
  });
});

describe("DELETE /v1/platform/workspaces/{id}", () => {
  it("removes the tenant's data rows in both schemas and leaves a sibling workspace intact", async () => {
    const key = await mintKey(null);
    const { POST: createWorkspace } = await import("../app/v1/platform/workspaces/route");
    await createWorkspace(
      req("/v1/platform/workspaces", {
        method: "POST",
        token: key.secret,
        body: { id: "del-w1", name: "Del W1", admin: { userId: "del-w1-admin" } },
      }) as any,
    );
    await createWorkspace(
      req("/v1/platform/workspaces", {
        method: "POST",
        token: key.secret,
        body: { id: "del-w2", name: "Del W2", admin: { userId: "del-w2-admin" } },
      }) as any,
    );

    const { POST: seed } = await import("../app/v1/platform/workspaces/[id]/seed/route");
    await seed(
      req("/v1/platform/workspaces/del-w1/seed", {
        method: "POST",
        token: key.secret,
        body: { seed: 3 },
      }) as any,
      ctx("del-w1"),
    );
    await seed(
      req("/v1/platform/workspaces/del-w2/seed", {
        method: "POST",
        token: key.secret,
        body: { seed: 3 },
      }) as any,
      ctx("del-w2"),
    );

    const cfg = loadConfig(enabledDir);
    const tables = new Set<string>();
    for (const name of Object.keys(cfg.collections))
      for (const t of declaredTables(name, cfg)) tables.add(t.table);

    const countIn = async (schema: "data_synth" | "data_live", table: string, wsId: string) =>
      Number(
        (
          await getAppPool().query(
            `select count(*)::int as n from ${schema}.${table} where workspace_id=$1`,
            [wsId],
          )
        ).rows[0].n,
      );

    const w2Before = new Map<string, number>();
    for (const table of tables) w2Before.set(table, await countIn("data_synth", table, "del-w2"));

    const { DELETE: deleteWorkspace } = await import("../app/v1/platform/workspaces/[id]/route");
    const delRes = await deleteWorkspace(
      req("/v1/platform/workspaces/del-w1", { method: "DELETE", token: key.secret }) as any,
      ctx("del-w1"),
    );
    expect(delRes.status).toBe(204);

    for (const table of tables) {
      expect(await countIn("data_synth", table, "del-w1")).toBe(0);
      expect(await countIn("data_live", table, "del-w1")).toBe(0);
      expect(await countIn("data_synth", table, "del-w2")).toBe(w2Before.get(table));
    }

    const gone = await getAppPool().query(`select 1 from app.workspaces where id='del-w1'`);
    expect(gone.rowCount).toBe(0);
  }, 30_000);
});

describe("POST /v1/platform/workspaces/{id}/seed", () => {
  it("seeds dev only, never live", async () => {
    const key = await mintKey(null);
    const { POST: createWorkspace } = await import("../app/v1/platform/workspaces/route");
    await createWorkspace(
      req("/v1/platform/workspaces", {
        method: "POST",
        token: key.secret,
        body: { id: "seed-w1", name: "Seed W1", admin: { userId: "seed-w1-admin" } },
      }) as any,
    );

    const { POST: seed } = await import("../app/v1/platform/workspaces/[id]/seed/route");
    const res = await seed(
      req("/v1/platform/workspaces/seed-w1/seed", {
        method: "POST",
        token: key.secret,
        body: { seed: 5 },
      }) as any,
      ctx("seed-w1"),
    );
    expect(res.status).toBe(200);

    const live = await getAppPool().query(
      `select count(*)::int as n from data_live.departments where workspace_id='seed-w1'`,
    );
    expect(live.rows[0].n).toBe(0);
  }, 30_000);
});

describe("with workspaces.enabled: false", () => {
  it("every route and method in the namespace is 404, even with a valid key", async () => {
    const key = await mintKey(null);
    // The key was minted while the flag was on; the flag governs the route surface, not the
    // key itself, so a valid key must still get a bare 404 once the namespace is unmounted.
    process.env.WAREHOUSD_PROJECT_DIR = harborDir;
    try {
      expect(getConfig().workspaces.enabled).toBe(false);

      const cases: Array<() => Promise<Response>> = [];
      const workspaces = await import("../app/v1/platform/workspaces/route");
      cases.push(() =>
        workspaces.POST(
          req("/v1/platform/workspaces", {
            method: "POST",
            token: key.secret,
            body: { id: "off-w1", name: "x", admin: { userId: "u" } },
          }) as any,
        ),
      );
      cases.push(() =>
        workspaces.GET(req("/v1/platform/workspaces", { token: key.secret }) as any),
      );

      const byId = await import("../app/v1/platform/workspaces/[id]/route");
      cases.push(() =>
        byId.GET(
          req("/v1/platform/workspaces/default", { token: key.secret }) as any,
          ctx("default"),
        ),
      );
      cases.push(() =>
        byId.DELETE(
          req("/v1/platform/workspaces/default", { method: "DELETE", token: key.secret }) as any,
          ctx("default"),
        ),
      );

      const members = await import("../app/v1/platform/workspaces/[id]/members/route");
      cases.push(() =>
        members.GET(
          req("/v1/platform/workspaces/default/members", { token: key.secret }) as any,
          ctx("default"),
        ),
      );
      cases.push(() =>
        members.POST(
          req("/v1/platform/workspaces/default/members", {
            method: "POST",
            token: key.secret,
            body: { userId: "u", role: "member" },
          }) as any,
          ctx("default"),
        ),
      );
      cases.push(() =>
        members.DELETE(
          req("/v1/platform/workspaces/default/members?userId=u", {
            method: "DELETE",
            token: key.secret,
          }) as any,
          ctx("default"),
        ),
      );

      const clients = await import("../app/v1/platform/workspaces/[id]/clients/route");
      cases.push(() =>
        clients.POST(
          req("/v1/platform/workspaces/default/clients", {
            method: "POST",
            token: key.secret,
            body: {},
          }) as any,
          ctx("default"),
        ),
      );

      const seedRoute = await import("../app/v1/platform/workspaces/[id]/seed/route");
      cases.push(() =>
        seedRoute.POST(
          req("/v1/platform/workspaces/default/seed", {
            method: "POST",
            token: key.secret,
            body: {},
          }) as any,
          ctx("default"),
        ),
      );

      for (const call of cases) {
        const res = await call();
        expect(res.status).toBe(404);
        const text = await res.text();
        expect(text).toBe("");
      }
    } finally {
      process.env.WAREHOUSD_PROJECT_DIR = enabledDir;
    }
  });
});
