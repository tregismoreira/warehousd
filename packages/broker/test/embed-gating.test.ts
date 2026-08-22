import { describe, it, expect, afterAll } from "vitest";
import type { Pool } from "pg";
import { ingestFile } from "../src/indexing/ingest";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, DEFAULT_WORKSPACE_ID } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { ConfigSchema } from "../src/config/schema";
import { DEFAULT_EMBEDDING_DIMENSIONS, type Embedder } from "../src/index";

const docCfg = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  synthetic: { documents_per_collection: {} },
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
});

describe("ingestFile: embedding gating (design test P2-2)", () => {
  let p: Provisioned;
  let db: Pool;

  afterAll(async () => {
    await db?.end();
    await p?.end();
  });

  it("re-indexing unchanged content triggers zero embedding calls, including a mere updatedAt change", async () => {
    p = await provision("embed-gating");
    db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, docCfg);

    let calls = 0;
    const embedder: Embedder = {
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      embed: (texts: string[]) => {
        calls++;
        return Promise.resolve(texts.map(() => new Array(DEFAULT_EMBEDDING_DIMENSIONS).fill(0)));
      },
    };

    const bytes = Buffer.from("# A\n\nalpha body");

    const r1 = await ingestFile(
      db,
      "data_synth",
      "policies",
      DEFAULT_WORKSPACE_ID,
      { path: "a.md", bytes, updatedAt: new Date("2026-08-01T00:00:00Z"), origin: "index" },
      { embedder },
    );
    expect(r1.status).toBe("indexed");
    expect(calls).toBeGreaterThan(0);
    const callsAfterFirst = calls;

    // Byte-identical input: nothing changed, so nothing should re-embed.
    const r2 = await ingestFile(
      db,
      "data_synth",
      "policies",
      DEFAULT_WORKSPACE_ID,
      { path: "a.md", bytes, updatedAt: new Date("2026-08-01T00:00:00Z"), origin: "index" },
      { embedder },
    );
    expect(r2.status).toBe("skipped");
    expect(calls).toBe(callsAfterFirst);

    // Same bytes, different updatedAt: the checksum is over the extracted text, not the bytes
    // or the timestamp, so this must still be a no-op.
    const r3 = await ingestFile(
      db,
      "data_synth",
      "policies",
      DEFAULT_WORKSPACE_ID,
      { path: "a.md", bytes, updatedAt: new Date("2026-09-15T00:00:00Z"), origin: "index" },
      { embedder },
    );
    expect(r3.status).toBe("skipped");
    expect(calls).toBe(callsAfterFirst);
  });
});
