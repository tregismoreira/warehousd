import type { Pool, PoolClient } from "pg";
import type { Embedder } from "../providers";
import { ident } from "../sql/ident";

// Fills the embedding column for a file collection's chunks.
//
// Deliberately resumable: it selects the rows that have no embedding yet and stops when there are
// none, so an interrupted run — a killed container, a provider rate limit, a laptop lid — costs
// only the batch in flight. Re-running it is always safe and never re-embeds work already done.
//
// pgvector's text input is `[1,2,3]`, and it is bound as a parameter and cast, never interpolated.

export type EmbedProgress = { embedded: number; remaining: number };

const toVector = (v: number[]): string => `[${v.join(",")}]`;

/**
 * @param batch how many chunks to embed per provider call. Small enough that a failure costs
 * little, large enough that a remote provider is not paying per-request latency per chunk.
 */
export async function embedCollection(
  db: Pool,
  env: "dev" | "live",
  collection: string,
  embedder: Embedder,
  workspaceId: string,
  opts: { batch?: number; onProgress?: (p: EmbedProgress) => void } = {},
): Promise<{ embedded: number }> {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const documents = `${schema}.${ident(`${collection}__documents`)}`;
  const batch = Math.max(1, opts.batch ?? 32);
  let embedded = 0;

  for (;;) {
    // Scanning "any row with no embedding" with no workspace filter used to reach every
    // workspace's pending chunks at once — the admin who pressed the button paid the provider
    // bill for other tenants' backlog, and the ids it wrote back could collide with another
    // workspace's under the same shared-seed synthetic id (see generate.ts's regeneration fix).
    const pending = await db.query<{ id: string; content: string }>(
      `select id, content from ${documents} where embedding is null and workspace_id = $1
       order by id limit $2`,
      [workspaceId, batch],
    );
    if (!pending.rowCount) break;

    const vectors = await embedder.embed(pending.rows.map((r) => r.content));
    if (vectors.length !== pending.rows.length)
      throw new Error(
        `embedder returned ${vectors.length} vectors for ${pending.rows.length} chunks`,
      );

    // One statement per batch rather than per row: `update ... from (values ...)` keeps the
    // round trips proportional to batches, which matters at a few thousand chunks. workspace_id
    // is bound once and matched on the base table, not per tuple — the ids just came from a
    // workspace-scoped select, but a shared-seed pk collision means the pk alone cannot be
    // trusted to name a row in only one workspace.
    const params: unknown[] = [workspaceId];
    const tuples = pending.rows.map((r, i) => {
      params.push(r.id, toVector(vectors[i]!));
      return `($${params.length - 1}::uuid, $${params.length}::vector)`;
    });
    await db.query(
      `update ${documents} as d set embedding = v.embedding
       from (values ${tuples.join(",")}) as v(id, embedding)
       where d.id = v.id and d.workspace_id = $1`,
      params,
    );

    embedded += pending.rows.length;
    if (opts.onProgress) {
      const left = await db.query<{ n: string }>(
        `select count(*) as n from ${documents} where embedding is null and workspace_id = $1`,
        [workspaceId],
      );
      opts.onProgress({ embedded, remaining: Number(left.rows[0]?.n ?? 0) });
    }
    // A short batch means the table is drained; skip the extra round trip.
    if (pending.rows.length < batch) break;
  }

  return { embedded };
}

/** Embed a set of chunks inline, inside the caller's transaction. Used by the indexer. */
export async function embedChunks(
  client: PoolClient,
  documentsTable: string,
  ids: string[],
  contents: string[],
  embedder: Embedder,
): Promise<void> {
  if (!ids.length) return;
  const vectors = await embedder.embed(contents);
  const params: unknown[] = [];
  const tuples = ids.map((id, i) => {
    params.push(id, toVector(vectors[i]!));
    return `($${params.length - 1}::uuid, $${params.length}::vector)`;
  });
  await client.query(
    `update ${documentsTable} as d set embedding = v.embedding
     from (values ${tuples.join(",")}) as v(id, embedding)
     where d.id = v.id`,
    params,
  );
}
