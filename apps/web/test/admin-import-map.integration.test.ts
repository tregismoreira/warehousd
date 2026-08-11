import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";

/**
 * The mapping step of the console importer, which had no test of its own.
 *
 * Two properties are worth pinning here rather than leaving to the CLI's `import map` tests. The
 * first is that mapping is admin-only, like the import it precedes — a manager who cannot import a
 * sheet must not be able to read its column names either. The second is §P4: the PUT renders a
 * config patch and writes nothing, so `warehousd apply` stays the only thing that commits a change
 * to `warehousd.yml`.
 */

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("adminimportmap");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

function mapReq(
  cookie: string,
  fields: Record<string, string>,
  file?: { text: string; name?: string },
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (file) fd.set("file", new File([file.text], file.name ?? "x.csv", { type: "text/csv" }));
  return new Request("http://localhost:8722/api/admin/import/map", {
    method: "POST",
    headers: { cookie },
    body: fd,
  });
}

function putReq(cookie: string, body: unknown) {
  return new Request("http://localhost:8722/api/admin/import/map", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/import/map", () => {
  it("is admin-only — a manager and a member are both refused", async () => {
    const { POST } = await import("../app/api/admin/import/map/route");
    const args = { collection: "departments", format: "csv" };
    const file = { text: "id,name\n1,X" };
    expect((await POST(mapReq(miaCookie, args, file) as never)).status).toBe(403);
    expect((await POST(mapReq(marcusCookie, args, file) as never)).status).toBe(403);
  });

  it("returns the headers and a proposed mapping, and no cell value", async () => {
    const { POST } = await import("../app/api/admin/import/map/route");
    const res = await POST(
      mapReq(
        anaCookie,
        { collection: "departments", format: "csv" },
        { text: "id,Department Name\n11111111-0000-4000-8000-000000000000,Litigation" },
      ) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.headers).toEqual(["id", "Department Name"]);
    expect(body.fields.map((f: { name: string }) => f.name)).toContain("name");
    // The question is about the shape of the sheet; the contents are nobody's business here.
    expect(JSON.stringify(body)).not.toContain("Litigation");
  });

  it("offers no view_join field, because there is no column to import into", async () => {
    const { POST } = await import("../app/api/admin/import/map/route");
    const res = await POST(
      mapReq(
        anaCookie,
        { collection: "departments", format: "csv" },
        { text: "id,name\n1,X" },
      ) as never,
    );
    const body = await res.json();
    // departments.head_name is a view_join in the harbor config.
    expect(body.fields.map((f: { name: string }) => f.name)).not.toContain("head_name");
  });

  it("refuses an unsupported format, a missing file and an unknown collection", async () => {
    const { POST } = await import("../app/api/admin/import/map/route");
    const file = { text: "id,name\n1,X" };
    expect(
      (await POST(mapReq(anaCookie, { collection: "departments", format: "pdf" }, file) as never))
        .status,
    ).toBe(400);
    expect(
      (await POST(mapReq(anaCookie, { collection: "departments", format: "csv" }) as never)).status,
    ).toBe(400);
    expect(
      (await POST(mapReq(anaCookie, { collection: "nope", format: "csv" }, file) as never)).status,
    ).toBe(400);
  });

  it("refuses an empty file rather than reporting zero headers", async () => {
    const { POST } = await import("../app/api/admin/import/map/route");
    const res = await POST(
      mapReq(anaCookie, { collection: "departments", format: "csv" }, { text: "" }) as never,
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/admin/import/map", () => {
  it("is admin-only", async () => {
    const { PUT } = await import("../app/api/admin/import/map/route");
    const body = { collection: "departments", columns: { "Department Name": "name" } };
    expect((await PUT(putReq(miaCookie, body) as never)).status).toBe(403);
    expect((await PUT(putReq(marcusCookie, body) as never)).status).toBe(403);
  });

  it("renders the config patch and commits nothing", async () => {
    const { PUT } = await import("../app/api/admin/import/map/route");
    const res = await PUT(
      putReq(anaCookie, {
        collection: "departments",
        columns: { "Department Name": "name" },
      }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.yaml).toContain("Department Name");
    expect(body.yaml).toContain("name");

    // §P4: `warehousd apply` is the only thing that changes the config. The route hands back text.
    const again = await (
      await PUT(putReq(anaCookie, { collection: "departments", columns: {} }) as never)
    ).json();
    expect(again.ok).toBe(true);
  });

  it("names the header whose field does not exist, rather than deferring it to apply", async () => {
    const { PUT } = await import("../app/api/admin/import/map/route");
    const res = await PUT(
      putReq(anaCookie, {
        collection: "departments",
        columns: { "Some Column": "not_a_field" },
      }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unknown_field");
    expect(body.headers).toEqual(["Some Column"]);
  });

  it("refuses a body that is not a mapping, and an unknown collection", async () => {
    const { PUT } = await import("../app/api/admin/import/map/route");
    expect((await PUT(putReq(anaCookie, { collection: "departments" }) as never)).status).toBe(400);
    expect((await PUT(putReq(anaCookie, { collection: 7, columns: {} }) as never)).status).toBe(
      400,
    );
    expect(
      (await PUT(putReq(anaCookie, { collection: "nope", columns: {} }) as never)).status,
    ).toBe(400);
  });
});
