import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;
const U = (n: number) => `1000000${n}-0000-4000-8000-000000000000`.slice(-36);

beforeAll(async () => {
  db = await setupWebDbWithData("adminimport");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function upload(cookie: string, collection: string, text: string, format = "csv", name = "x.csv") {
  const fd = new FormData();
  fd.set("collection", collection);
  fd.set("format", format);
  fd.set("file", new File([text], name, { type: "text/csv" }));
  return new Request("http://localhost:8722/api/admin/import", {
    method: "POST", headers: { cookie }, body: fd,
  });
}

describe("POST /api/admin/import", () => {
  it("403s for a member and for a manager — import is admin-only", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    expect((await POST(upload(miaCookie, "departments", `id,name\n${U(1)},X`) as any)).status).toBe(403);
    expect((await POST(upload(marcusCookie, "departments", `id,name\n${U(1)},X`) as any)).status).toBe(403);
  });

  it("imports a valid CSV and reports the count", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const res = await POST(upload(anaCookie, "departments", `id,name\n${U(2)},Imported Dept`) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, imported: 1 });
    const row = await getAppPool().query(`select name from data_live.departments where id=$1`, [U(2)]);
    expect(row.rows[0].name).toBe("Imported Dept");
  });

  it("returns per-row errors without echoing the offending values", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const res = await POST(upload(anaCookie, "departments",
      `id,name\nnot-a-uuid,Sensitive Dept Name`) as any);
    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(raw).not.toContain("Sensitive Dept Name");
    const body = JSON.parse(raw);
    expect(body.reason).toBe("validation_failed");
    expect(body.errors[0]).toMatchObject({ row: 0, column: "id", reason: "invalid_uuid" });
  });

  it("rejects a missing file", async () => {
    const fd = new FormData();
    fd.set("collection", "departments");
    fd.set("format", "csv");
    const { POST } = await import("../app/api/admin/import/route");
    const res = await POST(new Request("http://localhost:8722/api/admin/import", {
      method: "POST", headers: { cookie: anaCookie }, body: fd,
    }) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("no_file");
  });

  it("rejects an unsupported format", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const res = await POST(upload(anaCookie, "departments", "x", "xlsx") as any);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("unsupported_format");
  });

  it("rejects an oversized upload before parsing it", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const huge = "id,name\n" + `${U(3)},x\n`.repeat(400_000);
    const res = await POST(upload(anaCookie, "departments", huge) as any);
    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("file_too_large");
  });

  it("audits the import against the acting admin", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    await POST(upload(anaCookie, "departments", `id,name\n${U(4)},Audited`) as any);
    const ev = await getAppPool().query(
      `select user_id, env, collection, outcome from app.audit_events
       where intent->>'op' = 'import' order by at desc limit 1`);
    expect(ev.rows[0]).toMatchObject({
      user_id: "ana", env: "live", collection: "departments", outcome: "allowed",
    });
  });

  it("writes live regardless of the caller's env cookie", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const fd = new FormData();
    fd.set("collection", "departments");
    fd.set("format", "csv");
    fd.set("file", new File([`id,name\n${U(5)},Cookie Dev`], "x.csv"));
    const res = await POST(new Request("http://localhost:8722/api/admin/import", {
      method: "POST", headers: { cookie: `${anaCookie}; wh_env=dev` }, body: fd,
    }) as any);
    expect(res.status).toBe(200);
    const live = await getAppPool().query(`select 1 from data_live.departments where id=$1`, [U(5)]);
    const synth = await getAppPool().query(`select 1 from data_synth.departments where id=$1`, [U(5)]);
    expect(live.rowCount).toBe(1);
    expect(synth.rowCount).toBe(0);
  });
});
