import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { embedCollection, type Embedder } from "../src/index";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";

// PR 7's control-plane audit found embedCollection scanning "any row with no embedding" across
// every workspace at once — an admin in A pressing "Embed" consumed provider quota embedding B's
// backlog too, under B's audit trail missing entirely (the hand-written insert in
// apps/web/app/api/admin/embed/route.ts never named a workspace either). This is the canary per
// AGENTS.md non-negotiable 5.
const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  embedding: { provider: "local", model: "stub", dimensions: 2 },
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

const WS_A = "embedws-a";
const WS_B = "embedws-b";

function stubEmbedder(): Embedder {
  return { dimensions: 2, embed: (texts) => Promise.resolve(texts.map(() => [1, 0])) };
}

let p: Provisioned, admin: Pool;

async function seedChunk(workspaceId: string, word: string) {
  const fileId = randomUUID();
  await admin.query(
    `insert into data_synth."notes__files" (id, workspace_id, title, path, checksum, updated_at)
     values ($1,$2,$3,$3,$3, now())`,
    [fileId, workspaceId, `${word}.md`],
  );
  await admin.query(
    `insert into data_synth."notes__documents" (id, workspace_id, file_id, document_seq, content)
     values ($1,$2,$3,0,$4)`,
    [randomUUID(), workspaceId, fileId, `a note about ${word}`],
  );
}

beforeAll(async () => {
  p = await provision("embedwsscope");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await admin.query(
    `insert into app.workspaces (id, name) values ($1,'A'), ($2,'B') on conflict do nothing`,
    [WS_A, WS_B],
  );
  await applyConfig(admin, cfg);
}, 60_000);

afterAll(async () => {
  await admin?.end();
  await p?.end();
});

const unembeddedCount = async (workspaceId: string) =>
  Number(
    (
      await admin.query(
        `select count(*)::int as n from data_synth."notes__documents"
         where workspace_id=$1 and embedding is null`,
        [workspaceId],
      )
    ).rows[0].n,
  );

describe("embedCollection is scoped to the workspace it was called for", () => {
  it("embedding workspace A leaves workspace B's chunks untouched", async () => {
    await seedChunk(WS_A, "finance");
    await seedChunk(WS_B, "legal");
    expect(await unembeddedCount(WS_A)).toBe(1);
    expect(await unembeddedCount(WS_B)).toBe(1);

    const r = await embedCollection(admin, "dev", "notes", stubEmbedder(), WS_A);
    expect(r.embedded).toBe(1);

    expect(await unembeddedCount(WS_A)).toBe(0);
    expect(await unembeddedCount(WS_B)).toBe(1);
  });
});
