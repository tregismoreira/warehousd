import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

// The browser upload path, through the real routes.
//
// The route half of this feature is mostly a gate: admin only, one file per request, and a plan
// endpoint that must not become a way to ask questions about a collection you cannot reach.
// The ingestion behaviour itself is covered in packages/broker/test/upload.integration.test.ts.

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;

// `policies` binds the `department` and `tags` vocabularies, so every upload into it has to
// carry a term — which is what makes it the useful collection to test against.
const COLLECTION = "policies";

beforeAll(async () => {
  db = await setupWebDbWithData("admindocs");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);

afterAll(async () => {
  await db?.end();
});

function uploadReq(
  cookie: string,
  path: string,
  body: string | Uint8Array,
  over: Record<string, string> = {},
) {
  const fd = new FormData();
  fd.set("collection", over.collection ?? COLLECTION);
  fd.set("env", over.env ?? "dev");
  fd.set("path", path);
  if (over.checksum !== undefined) fd.set("checksum", over.checksum);
  fd.set("sidecar", over.sidecar ?? JSON.stringify({ department: "hr", tags: ["compliance"] }));
  fd.set("file", new File([body as BlobPart], path.split("/").pop()!));
  return new Request("http://localhost:8722/api/admin/documents", {
    method: "POST",
    headers: { cookie },
    body: fd,
  });
}

function planReq(cookie: string, body: unknown) {
  return new Request("http://localhost:8722/api/admin/documents/plan", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const post = async (req: Request) => {
  const { POST } = await import("../app/api/admin/documents/route");
  return POST(req as never);
};
const plan = async (req: Request) => {
  const { POST } = await import("../app/api/admin/documents/plan/route");
  return POST(req as never);
};

describe("POST /api/admin/documents", () => {
  it("403s for a member and for a manager — deciding what content exists is admin-only", async () => {
    expect((await post(uploadReq(miaCookie, "a.md", "# A\n\nBody."))).status).toBe(403);
    expect((await post(uploadReq(marcusCookie, "a.md", "# A\n\nBody."))).status).toBe(403);
  });

  it("stores a markdown file and reports the document it created", async () => {
    const res = await post(uploadReq(anaCookie, "uploaded/a.md", "# Uploaded A\n\nBody text."));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: "indexed", title: "Uploaded A" });
    const row = await getAppPool().query(
      `select origin from data_synth."policies__files" where path='uploaded/a.md'`,
    );
    // `origin` is what stops the next `warehousd index` from sweeping it away.
    expect(row.rows[0].origin).toBe("upload");
  });

  it("refuses an unsupported extension, a bad env and a missing file", async () => {
    expect((await post(uploadReq(anaCookie, "a.png", "x"))).status).toBe(400);
    expect((await post(uploadReq(anaCookie, "a.md", "x", { env: "prod" }))).status).toBe(400);
    const fd = new FormData();
    fd.set("collection", COLLECTION);
    fd.set("env", "dev");
    const res = await post(
      new Request("http://localhost:8722/api/admin/documents", {
        method: "POST",
        headers: { cookie: anaCookie },
        body: fd,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_file");
  });

  it("refuses a path that tries to climb out of the collection", async () => {
    for (const p of ["../escape.md", "a/../../b.md", "/abs.md"]) {
      const res = await post(uploadReq(anaCookie, p, "# X\n\nBody."));
      // A leading slash is stripped rather than refused; the rest are refused outright.
      if (p === "/abs.md") expect(res.status).toBe(200);
      else expect(res.status).toBe(400);
    }
  });

  it("refuses a file with no term for a bound vocabulary, and says which", async () => {
    const res = await post(
      uploadReq(anaCookie, "no-term.md", "# No term\n\nBody.", { sidecar: "{}" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("rejected");
    expect(body.detail).toMatch(/missing required department/);
    expect(
      (
        await getAppPool().query(
          `select 1 from data_synth."policies__files" where path='no-term.md'`,
        )
      ).rowCount,
    ).toBe(0);
  });

  it("refuses a dataset collection — this surface is for documents", async () => {
    const res = await post(
      uploadReq(anaCookie, "a.md", "# A\n\nB.", { collection: "departments" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_a_file_collection");
  });

  it("writes one audit row naming the path", async () => {
    await post(uploadReq(anaCookie, "audited.md", "# Audited\n\nBody."));
    const rows = await getAppPool().query(
      `select intent from app.audit_events
        where collection='policies' and intent->>'op'='document:upload'
          and intent->>'path'='audited.md'`,
    );
    expect(rows.rowCount).toBe(1);
  });

  // PR 7's control-plane audit found auditDocument's hand-written insert leaving workspace_id at
  // its table default regardless of which workspace's admin acted — every document audit row
  // read as workspace A's, even when the acting admin's active workspace was something else.
  // Fails without the fix: the row's workspace_id would read 'default' no matter what is passed.
  it("audits a document operation under the caller's actual workspace, not the column default", async () => {
    const { loadConfig } = await import("@warehousd/broker");
    const { auditDocument } = await import("../lib/documents");
    const cfg = loadConfig(process.env.WAREHOUSD_PROJECT_DIR!);
    const app = getAppPool();
    await app.query(
      `insert into app.workspaces (id, name) values ('docs-other','Other') on conflict do nothing`,
    );
    await auditDocument(app, cfg, "ana", "docs-other", "dev", "policies", {
      op: "document:upload",
      path: "workspace-scoped.md",
    });
    const row = await app.query(
      `select workspace_id from app.audit_events
        where intent->>'op'='document:upload' and intent->>'path'='workspace-scoped.md'`,
    );
    expect(row.rows[0].workspace_id).toBe("docs-other");
  });
});

describe("POST /api/admin/documents/plan", () => {
  it("403s for anyone but an admin", async () => {
    expect(
      (await plan(planReq(miaCookie, { collection: COLLECTION, env: "dev", files: [] }))).status,
    ).toBe(403);
  });

  it("reports what is already stored, so an interrupted upload resumes", async () => {
    const text = "# Resumable\n\nBody text.";
    await post(uploadReq(anaCookie, "resume/a.md", text));
    const checksum = await sha256(text);
    const res = await plan(
      planReq(anaCookie, {
        collection: COLLECTION,
        env: "dev",
        files: [
          { path: "resume/a.md", checksum },
          { path: "resume/never.md", checksum },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).plan).toEqual([
      { path: "resume/a.md", status: "unchanged" },
      { path: "resume/never.md", status: "new" },
    ]);
  });

  it("refuses a malformed checksum rather than planning around it", async () => {
    // Accepting one would silently plan every file as `changed` and re-upload the whole corpus
    // on every session — the feature appearing to work while doing the opposite.
    const res = await plan(
      planReq(anaCookie, {
        collection: COLLECTION,
        env: "dev",
        files: [{ path: "a.md", checksum: "nope" }],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_checksum");
  });

  it("refuses an unknown collection and a bad body", async () => {
    expect(
      (await plan(planReq(anaCookie, { collection: "nope", env: "dev", files: [] }))).status,
    ).toBe(404);
    expect((await plan(planReq(anaCookie, { collection: COLLECTION, env: "dev" }))).status).toBe(
      400,
    );
  });
});

describe("DELETE and raw download", () => {
  it("deletes an uploaded document, audits it, and 404s the second time", async () => {
    const created = await (await post(uploadReq(anaCookie, "delete-me.md", "# D\n\nBody."))).json();
    const { DELETE } = await import("../app/api/admin/documents/[fileId]/route");
    const url = `http://localhost:8722/api/admin/documents/${created.fileId}?collection=${COLLECTION}&env=dev`;
    const req = () => new Request(url, { method: "DELETE", headers: { cookie: anaCookie } });
    const params = Promise.resolve({ fileId: created.fileId as string });

    const first = await DELETE(req() as never, { params });
    expect(first.status).toBe(200);
    const second = await DELETE(req() as never, { params });
    expect(second.status).toBe(404);

    const audit = await getAppPool().query(
      `select 1 from app.audit_events where intent->>'op'='document:delete'
         and intent->>'fileId'=$1`,
      [created.fileId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("serves the original only to an admin, and audits the read", async () => {
    const created = await (await post(uploadReq(anaCookie, "raw.md", "# Raw\n\nOriginal."))).json();
    const { GET } = await import("../app/api/admin/documents/[fileId]/raw/route");
    const url = `http://localhost:8722/api/admin/documents/${created.fileId}/raw?collection=${COLLECTION}&env=dev`;
    const params = Promise.resolve({ fileId: created.fileId as string });

    const denied = await GET(new Request(url, { headers: { cookie: miaCookie } }) as never, {
      params,
    });
    expect(denied.status).toBe(403);

    const res = await GET(new Request(url, { headers: { cookie: anaCookie } }) as never, {
      params,
    });
    expect(res.status).toBe(200);
    // Never inline: an uploaded file rendered in the console's own origin would run there.
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("# Raw\n\nOriginal.");

    const audit = await getAppPool().query(
      `select 1 from app.audit_events where intent->>'op'='document:download'
         and intent->>'fileId'=$1`,
      [created.fileId],
    );
    expect(audit.rowCount).toBe(1);
  });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
