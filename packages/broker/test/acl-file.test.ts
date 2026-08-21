import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { indexCollection } from "../src/indexing";
import { requestGrant, approveGrant } from "../src/grants/manage";
import { setUserGroups } from "../src/acl/manage";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";

// Per-document ACLs on a FILE collection.
//
// Previously refused outright by config: an ACL is keyed on the declared primary key and a file
// collection declares none, because its documents are chunks of a file. The answer is that it is
// keyed on `path` — a file's identity within a collection — and the policy attaches to the FILE
// row, so every chunk of one document shares it.
//
// `path` and not `file_id` is the load-bearing choice, and the last describe block is why.

const CANARY = "zzcanary-restricted-file-body-zz";

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  collections: {
    policies: {
      description: "Policies",
      type: "file",
      source: "./policies",
      acl: true,
      fields: {
        title: { posture: "allow" },
        content: { posture: "allow" },
        path: { posture: "deny" },
        owner: { posture: "allow" },
      },
    },
  },
});

let p: Provisioned, admin: Pool, pools: Pools;
let broker: ReturnType<typeof makeBroker>;
let dir: string;

const CONSOLE = { kind: "console" } as const;

async function user(id: string, role: string) {
  await admin.query(
    `insert into app."user" (id, name, email, "emailVerified", role, "workspaceId", "createdAt", "updatedAt")
     values ($1,$1,$1||'@t.local',true,$2,'default',now(),now())
     on conflict (id) do update set role=excluded.role`,
    [id, role],
  );
  await admin.query(
    `insert into app.workspace_members (workspace_id, user_id, role) values ('default',$1,$2)
     on conflict (workspace_id, user_id) do update set role=excluded.role`,
    [id, role],
  );
}

async function reindex() {
  return indexCollection(admin, "dev", "policies", dir, "default");
}

beforeAll(async () => {
  p = await provision("acl-file");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  // The write pool matters even though nothing here writes a document: `_acl` is a base table and
  // the read roles hold nothing on it, so setDocumentAcl goes through the write role.
  pools = createPools({
    app: p.urls.admin,
    dev: p.urls.dev,
    live: p.urls.live,
    devWrite: p.urls.devWrite,
    liveWrite: p.urls.liveWrite,
  });
  broker = makeBroker(pools, cfg);

  await admin.query(`create table if not exists app."user" (
    id text primary key, name text, email text, "emailVerified" boolean,
    role text, "workspaceId" text not null default 'default',
    "createdAt" timestamptz, "updatedAt" timestamptz)`);
  await user("boss", "manager");
  await user("ana", "member");
  await user("mia", "member");

  dir = mkdtempSync(join(tmpdir(), "wh-aclfile-"));
  writeFileSync(join(dir, "public.md"), "# Public\n\nanyone may read this");
  writeFileSync(join(dir, "secret.md"), `# Secret\n\n${CANARY}`);
  await reindex();

  // Both callers hold the SAME grant on the whole collection. Everything that differs below is
  // the per-document ACL and nothing else.
  for (const who of ["ana", "mia"]) {
    const id = await requestGrant(admin, {
      userId: who,
      collection: "policies",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "t",
      allowedFields: ["title", "content", "owner"],
    });
    const r = await approveGrant(admin, cfg, id, "boss", {
      allowedFields: ["title", "content", "owner"],
    });
    if (!r.ok) throw new Error(r.error);
  }

  await setUserGroups(admin, {
    workspaceId: "default",
    userId: "ana",
    groups: ["legal"],
    source: "manual",
  });
}, 90_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await admin.end();
  await pools.end();
  await p.end();
});

/** Restrict `secret.md` to the legal group. Addressed by PATH, which is the file's identity. */
async function restrictSecret(principals: string[] = ["group:legal"]) {
  const r = await broker.setDocumentAcl(makeCtx({ userId: "boss" }), CONSOLE, {
    collection: "policies",
    id: "secret.md",
    principals,
  });
  if (!r.ok) throw new Error(`setDocumentAcl refused: ${r.reason}`);
  return r;
}

describe("config now accepts acl: true on a file collection", () => {
  it("parses", () => {
    expect(cfg.collections.policies!.acl).toBe(true);
  });

  it("still refuses it on a source_ref collection", () => {
    const r = ConfigSchema.safeParse({
      project: "t",
      sources: { hr: { type: "postgres", url: "postgres://x" } },
      collections: {
        remote: {
          description: "d",
          acl: true,
          source_ref: { source: "hr", table: "people" },
          fields: { id: { type: "uuid", posture: "allow", pk: true } },
        },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("source_ref collection");
  });

  it("still refuses it on a dataset with no primary key", () => {
    const r = ConfigSchema.safeParse({
      project: "t",
      collections: {
        d: { description: "d", acl: true, fields: { a: { type: "text", posture: "allow" } } },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("pk: true");
  });
});

describe("the ACL filters every read path", () => {
  beforeAll(async () => {
    await restrictSecret();
  });

  it("query returns the restricted file's chunks only to a principal on its ACL", async () => {
    const inGroup = await broker.query(makeCtx({ userId: "ana" }), { collection: "policies" });
    const outside = await broker.query(makeCtx({ userId: "mia" }), { collection: "policies" });
    expect(inGroup.ok && outside.ok).toBe(true);
    if (!inGroup.ok || !outside.ok) throw new Error("unreachable");

    expect(inGroup.documents.some((d) => String(d.title) === "Secret")).toBe(true);
    // Absent, not refused. Distinguishing "you may not" from "there is none" is the disclosure.
    expect(outside.documents.some((d) => String(d.title) === "Secret")).toBe(false);
    expect(outside.documents.some((d) => String(d.title) === "Public")).toBe(true);
    expect(JSON.stringify(outside)).not.toContain(CANARY);
  });

  it("an aggregate counts what the caller may see, not what exists", async () => {
    const count = async (userId: string) => {
      const r = await broker.query(makeCtx({ userId }), {
        collection: "policies",
        aggregate: [{ fn: "count", field: "title" }],
      });
      if (!r.ok) throw new Error("unreachable");
      return Number(Object.values(r.documents[0]!)[0]);
    };
    // If the predicate landed after the aggregate, the shortfall would itself report how many
    // documents the caller cannot see.
    expect(await count("ana")).toBeGreaterThan(await count("mia"));
  });

  it("search never returns a chunk of a restricted file", async () => {
    const res = await broker.searchDocuments(makeCtx({ userId: "mia" }), {
      collection: "policies",
      q: "secret",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.documents.some((d) => String(d.title) === "Secret")).toBe(false);
    expect(JSON.stringify(res)).not.toContain(CANARY);
  });

  it("getDocument by path refuses not_found, exactly as an absent file would", async () => {
    const res = await broker.getDocument(makeCtx({ userId: "mia" }), {
      collection: "policies",
      path: "secret.md",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
    expect(JSON.stringify(res)).not.toContain(CANARY);
  });

  it("getDocument by file_id refuses too — the policy is on the document, not the address", async () => {
    const row = await admin.query<{ id: string }>(
      `select id from data_synth."policies__files" where path='secret.md'`,
    );
    const res = await broker.getDocument(makeCtx({ userId: "mia" }), {
      collection: "policies",
      id: row.rows[0]!.id,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  it("reassembles every chunk for a caller who IS on the ACL", async () => {
    const res = await broker.getDocument(makeCtx({ userId: "ana" }), {
      collection: "policies",
      path: "secret.md",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(String(res.document.content)).toContain(CANARY);
  });
});

describe("the console verbs address a file by path", () => {
  it("reads back what was written", async () => {
    await restrictSecret(["group:legal", "user:mia"]);
    const r = await broker.getDocumentAcl(makeCtx({ userId: "boss" }), CONSOLE, {
      collection: "policies",
      id: "secret.md",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.acl.principals.sort()).toEqual(["group:legal", "user:mia"]);
  });

  it("an empty principal list makes the document public again", async () => {
    await restrictSecret([]);
    const res = await broker.query(makeCtx({ userId: "mia" }), { collection: "policies" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.documents.some((d) => String(d.title) === "Secret")).toBe(true);
    await restrictSecret();
  });

  it("refuses a member — an ACL is not something a grant can widen", async () => {
    const r = await broker.setDocumentAcl(makeCtx({ userId: "mia" }), CONSOLE, {
      collection: "policies",
      id: "secret.md",
      principals: ["user:mia"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("acl_denied");
  });
});

// The reason the key is `path`. `file_id` is stable across a re-index — ingestFile updates the row
// in place — but the delete sweep removes the row when a file leaves the source directory, so a
// file that comes back gets a fresh uuid. An ACL keyed on the surrogate would be orphaned and the
// returning document would be readable by everyone the grant covers.
describe("the restriction survives the file's own lifecycle", () => {
  it("survives a re-index that changes the content", async () => {
    await restrictSecret();
    writeFileSync(join(dir, "secret.md"), `# Secret\n\n${CANARY} and more`);
    const r = await reindex();
    expect(r.indexed).toBeGreaterThan(0);

    const res = await broker.query(makeCtx({ userId: "mia" }), { collection: "policies" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.documents.some((d) => String(d.title) === "Secret")).toBe(false);
  });

  it("survives the file leaving the directory and coming back", async () => {
    await restrictSecret();
    const idBefore = (
      await admin.query<{ id: string }>(
        `select id from data_synth."policies__files" where path='secret.md'`,
      )
    ).rows[0]!.id;

    rmSync(join(dir, "secret.md"));
    const gone = await reindex();
    expect(gone.deleted).toBe(1);

    writeFileSync(join(dir, "secret.md"), `# Secret\n\n${CANARY}`);
    await reindex();

    const idAfter = (
      await admin.query<{ id: string }>(
        `select id from data_synth."policies__files" where path='secret.md'`,
      )
    ).rows[0]!.id;
    // A genuinely new row — which is exactly what would have orphaned a file_id-keyed ACL.
    expect(idAfter).not.toBe(idBefore);

    const outside = await broker.query(makeCtx({ userId: "mia" }), { collection: "policies" });
    const inGroup = await broker.query(makeCtx({ userId: "ana" }), { collection: "policies" });
    if (!outside.ok || !inGroup.ok) throw new Error("unreachable");
    // Fail closed: the restriction came back with the file.
    expect(outside.documents.some((d) => String(d.title) === "Secret")).toBe(false);
    expect(inGroup.documents.some((d) => String(d.title) === "Secret")).toBe(true);
    expect(JSON.stringify(outside)).not.toContain(CANARY);
  });
});
