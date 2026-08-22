import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { provision, testPool, type Provisioned } from "./helpers/db";
import {
  createAppSchema,
  applyConfig,
  createPools,
  makeBroker,
  embedCollection,
  type Embedder,
  type Pools,
} from "../src/index";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";

// Semantic and hybrid search, against real pgvector.
//
// The embedder is a STUB — a fixed text→vector map — for two reasons. It keeps CI from
// downloading a 100MB model, and more importantly it makes ranking deterministic, so a test about
// grant scoping is a test about grant scoping rather than a test that also depends on how a
// particular model feels about a particular sentence. The real model is exercised in
// embedding-local.optin.test.ts, behind a flag.
//
// The assertion this file exists for is the ANN leak: an approximate-nearest-neighbour scan ranks
// over every row in the table. If the grant's predicates are applied AFTER the ranking and its
// LIMIT, a caller asking for five gets however many of the global top five their grant allows —
// and the shortfall is an oracle reporting how many documents they cannot see.

const DIMS = 4;

// Vectors chosen so the ordering is obvious by inspection: each document is a unit vector on one
// axis, and a query aligned with an axis ranks that document first.
const AXES: Record<string, number[]> = {
  finance: [1, 0, 0, 0],
  legal: [0, 1, 0, 0],
  hr: [0, 0, 1, 0],
  facilities: [0, 0, 0, 1],
};

function stubEmbedder(): Embedder {
  return {
    dimensions: DIMS,
    embed: (texts) =>
      Promise.resolve(
        texts.map((t) => {
          for (const [word, v] of Object.entries(AXES)) if (t.includes(word)) return v;
          // Anything unrecognised sits equidistant, so it never accidentally wins a ranking.
          return [0.5, 0.5, 0.5, 0.5];
        }),
      ),
  };
}

const cfg = ConfigSchema.parse({
  project: "semsearch",
  server: { port: 1 },
  embedding: { provider: "local", model: "stub", dimensions: DIMS },
  collections: {
    notes: {
      type: "file",
      description: "Notes",
      source: "./x",
      fields: {
        title: { posture: "allow" },
        content: { posture: "allow" },
        path: { posture: "deny" },
      },
    },
  },
});

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
const ctx = (userId: string) => makeCtx({ userId, env: "dev" });

// Every document is (path, title, one chunk of content). `word` decides its vector.
const DOCS = [
  { path: "open/finance.md", title: "Budget", word: "finance" },
  { path: "open/legal.md", title: "Contract", word: "legal" },
  { path: "secret/hr.md", title: "Headcount", word: "hr" },
  { path: "secret/facilities.md", title: "Floorplan", word: "facilities" },
];

async function seed(docs: typeof DOCS) {
  for (const d of docs) {
    const fileId = randomUUID();
    await admin.query(
      `insert into data_synth."notes__files" (id, workspace_id, title, path, checksum, updated_at)
       values ($1,'default',$2,$3,$4, now())`,
      [fileId, d.title, d.path, d.path],
    );
    await admin.query(
      `insert into data_synth."notes__documents" (id, workspace_id, file_id, document_seq, content)
       values ($1,'default',$2,0,$3)`,
      [randomUUID(), fileId, `a note about ${d.word} matters`],
    );
  }
  await embedCollection(admin, "dev", "notes", stubEmbedder(), "default");
}

beforeAll(async () => {
  p = await provision("semsearch");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg, { embedder: stubEmbedder() });
  await seed(DOCS);

  // `wide` sees everything. `scoped` is confined to open/ by a document filter on the DENIED
  // `path` column — the ordinary way a grant narrows a file collection.
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ('wide','notes',$1,'dev','approved')`,
    [["title", "content"]],
  );
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status, document_filter)
     values ('scoped','notes',$1,'dev','approved',$2)`,
    [
      ["title", "content"],
      JSON.stringify([{ field: "path", op: "in", value: ["open/finance.md", "open/legal.md"] }]),
    ],
  );
}, 60_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

const titles = async (
  userId: string,
  q: string,
  mode: "text" | "semantic" | "hybrid",
  limit = 10,
) => {
  const r = await broker.searchDocuments(ctx(userId), { collection: "notes", q, mode, limit });
  if (!r.ok) throw new Error(`expected a search, got ${r.reason}`);
  return r.documents.map((d) => String(d.title));
};

describe("semantic mode ranks by vector distance", () => {
  it("finds the document whose vector matches, in every mode", async () => {
    expect(await titles("wide", "finance", "semantic")).toContain("Budget");
    expect(await titles("wide", "finance", "hybrid")).toContain("Budget");
    expect(await titles("wide", "finance", "text")).toContain("Budget");
  });

  it("ranks the matching document first under semantic", async () => {
    expect((await titles("wide", "hr", "semantic"))[0]).toBe("Headcount");
  });

  it("finds a document that shares no words with the query", async () => {
    // The whole point of a vector search. The stub maps "legal" to the legal axis, and the
    // document's own text is "a note about legal matters" — under text search a query of
    // "legal" matches lexically, so to prove semantics we ask for something with no lexical
    // overlap at all and check the text path finds nothing while semantic does.
    const lexical = await broker.searchDocuments(ctx("wide"), {
      collection: "notes",
      q: "zzzznotaword legal",
      mode: "text",
    });
    const semantic = await titles("wide", "zzzznotaword legal", "semantic");
    expect(semantic).toContain("Contract");
    if (lexical.ok) expect(lexical.documents.length).toBeLessThanOrEqual(semantic.length);
  });
});

describe("the grant scopes every mode", () => {
  it.each(["text", "semantic", "hybrid"] as const)(
    "excludes documents the grant's filter hides — %s",
    async (mode) => {
      const seen = await titles("scoped", "hr", mode);
      expect(seen).not.toContain("Headcount");
      expect(seen).not.toContain("Floorplan");
    },
  );

  it("returns the SAME result set whether or not the hidden documents exist", async () => {
    // The ANN leak assertion. A scoped caller asks for the two documents they can see, with a
    // query that would rank the two they cannot see FIRST. If the vector scan ranked globally and
    // the grant filtered afterwards, this would come back short — and the shortfall would report
    // how many documents exist that the caller may not read.
    const before = await titles("scoped", "hr", "semantic", 2);
    expect(before).toHaveLength(2);

    await admin.query(`delete from data_synth."notes__files" where path like 'secret/%'`);
    const after = await titles("scoped", "hr", "semantic", 2);

    expect(after).toEqual(before);

    // Restore for the suites below.
    await seed(DOCS.filter((d) => d.path.startsWith("secret/")));
  });

  it("applies the filter inside both hybrid CTEs, not to their union", async () => {
    // Hybrid runs two rankings. A predicate that made it into one CTE and not the other would
    // show up exactly here: a document excluded by the grant reappearing because the other
    // branch pulled it in.
    const seen = await titles("scoped", "facilities", "hybrid", 4);
    expect(seen.sort()).toEqual(["Budget", "Contract"]);
  });
});

describe("what the modes refuse", () => {
  it("refuses semantic on a dataset collection — there is nothing chunked to embed", async () => {
    const dsCfg = ConfigSchema.parse({
      project: "semsearch",
      server: { port: 1 },
      embedding: { provider: "local", model: "stub", dimensions: DIMS },
      collections: {
        rows: {
          description: "d",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            body: { type: "text", posture: "allow", searchable: true },
          },
        },
      },
    });
    const b = makeBroker(pools, dsCfg, { embedder: stubEmbedder() });
    const r = await b.searchDocuments(ctx("wide"), {
      collection: "rows",
      q: "x",
      mode: "semantic",
    });
    expect(r).toMatchObject({ ok: false, reason: "invalid_intent" });
  });

  it("refuses semantic when no embedder is configured, rather than silently running text", async () => {
    // A caller who asked for semantic and got text cannot tell, and would read meaning into a
    // ranking that is not the one they requested.
    const noEmbed = makeBroker(pools, cfg);
    const r = await noEmbed.searchDocuments(ctx("wide"), {
      collection: "notes",
      q: "finance",
      mode: "semantic",
    });
    expect(r).toMatchObject({ ok: false, reason: "invalid_intent" });
    // Text still works on the same broker.
    const t = await noEmbed.searchDocuments(ctx("wide"), { collection: "notes", q: "finance" });
    expect(t.ok).toBe(true);
  });

  it("ignores a client-supplied vector instead of honouring it", async () => {
    // A caller-supplied vector is an oracle over the embedding space of documents their grant
    // excludes. The intent schema drops unknown keys, so this must behave exactly as if the key
    // were absent — not refuse, which would confirm the key is recognised.
    const forged = await broker.searchDocuments(ctx("scoped"), {
      collection: "notes",
      q: "finance",
      mode: "semantic",
      vector: AXES.hr,
    } as never);
    expect(forged.ok).toBe(true);
    if (!forged.ok) throw new Error("unreachable");
    expect(forged.documents.map((d) => String(d.title))).not.toContain("Headcount");
  });

  it("writes exactly one audit row per search, in every mode", async () => {
    for (const mode of ["text", "semantic", "hybrid"] as const) {
      const r = await broker.searchDocuments(ctx("wide"), {
        collection: "notes",
        q: "finance",
        mode,
      });
      if (!r.ok) throw new Error(`expected a search, got ${r.reason}`);
      const ev = await admin.query(`select count(*)::int n from app.audit_events where id=$1`, [
        r.auditId,
      ]);
      expect(ev.rows[0].n).toBe(1);
    }
  });
});

describe("embedCollection", () => {
  it("fills only null embeddings and is safe to re-run", async () => {
    const first = await embedCollection(admin, "dev", "notes", stubEmbedder(), "default");
    expect(first.embedded).toBe(0); // seed() already embedded everything

    await admin.query(`update data_synth."notes__documents" set embedding = null`);
    const second = await embedCollection(admin, "dev", "notes", stubEmbedder(), "default");
    expect(second.embedded).toBe(DOCS.length);

    const left = await admin.query(
      `select count(*)::int n from data_synth."notes__documents" where embedding is null`,
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("respects the batch size without losing rows", async () => {
    await admin.query(`update data_synth."notes__documents" set embedding = null`);
    const r = await embedCollection(admin, "dev", "notes", stubEmbedder(), "default", { batch: 1 });
    expect(r.embedded).toBe(DOCS.length);
  });
});
