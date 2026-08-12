import { randomUUID, createHash } from "node:crypto";
import { kindOf } from "../config/kinds";
import type { Pool } from "pg";
import type { BrokerContext, MutationIntent, MutationResult } from "../types";
import type { CollectionConfig } from "../config/schema";
import { writePosture } from "../config/schema";
import type { ActiveGrant } from "../grants/eval";
import { admits, validateDocumentFilters } from "../grants/filters";
import { withWorkspace, writePool } from "../db/pools";
import { insertRevision, currentRevision, reviseDocument } from "../db/revisions";
import { supportedVerbs } from "../config/load";
import { pkOf, dataColsOf, dataSchema } from "../config/collection";
import { ident } from "../sql/ident";
import { aclColumnSql } from "../acl/sql";
import { chunkText } from "../indexing/chunk";
import { coerce } from "../import/validate";
import { makeAuditWriter, assertRecorded, type AuditWriter } from "../audit/decision";
import { MutationIntentSchema, checkIntent } from "../intents/schema";
import { writeChangeLog } from "./history";
import { resolveGranted } from "./guard";
import { proposeDataset } from "./propose";
import type { VerbDeps } from "./deps";

export function makeMutateVerb(d: VerbDeps) {
  const { app, cfg, pools } = d;

  return async function mutate(ctx: BrokerContext, raw: MutationIntent): Promise<MutationResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    // Parsed before `values` is read: refuseMutation reaches into intent.values to record the
    // field names it touched, so an unparsed intent cannot even be refused safely.
    const parsed = checkIntent(MutationIntentSchema, raw, "mutate");
    if (!parsed.ok) return audit.refuse(parsed.collection, "invalid_intent");
    const intent = parsed.intent;
    const values = intent.op !== "delete" ? intent.values : {};
    const fieldNames = Object.keys(values);

    // 1. intent shape
    //
    // `&& !intent.values` used to be a third clause on the create guard, which made it
    // unreachable: MutationIntentSchema requires `values` on a create, so it is always an object,
    // and `{}` is truthy. An empty-values create therefore fell through to the insert and wrote a
    // row of all nulls under a generated uuid pk — a document with no content, which nothing
    // further down the write path would have stopped either.
    //
    // Both refuse through refuseMutation rather than refuse: the latter is the query-shaped helper
    // and records `intent: null`, so the same mutation audited differently depending on which of
    // these two lines rejected it.
    if (intent.op === "create" && !fieldNames.length)
      return audit.refuseMutation(intent, null, "invalid_intent");
    if ((intent.op === "update" || intent.op === "delete") && !intent.id)
      return audit.refuseMutation(intent, null, "invalid_intent");

    // 2-6. collection exists, is writable, supports this op, and the caller holds a grant that
    // carries the verb. Through the same guard the read verbs use — see verbs/guard.ts.
    //
    // `collectionCheck` holds the three structural questions, which are answerable without a
    // grant and so are asked before one is loaded. `checkFilters: false` keeps the document-filter
    // check below in this file, because a mutation audits that refusal through `refuseMutation`:
    // a mutation's audit row records the op and the field NAMES it touched, and routing it through
    // the query-shaped writer would record `intent: null` for a write.
    const g = await resolveGranted(d, audit, ctx, intent.collection, intent.op, {
      checkFilters: false,
      collectionCheck: (col) => {
        if (!col.writable) return "not_writable";
        // An external collection's rows belong to the remote system. The database refuses the
        // write too — the foreign table is `updatable 'false'` and no role holds INSERT on it —
        // so this is the readable refusal in front of a privilege wall, not the wall itself.
        if (col.source_ref) return "not_writable";
        if (!supportedVerbs(cfg, intent.collection).includes(intent.op))
          return "verb_not_supported";
        return null;
      },
    });
    if (!g.ok) return g;
    const { collection: c, grant } = g;

    // 6b. the grant's document filters must be evaluable. matchesFilters below fails closed on a
    // filter it cannot interpret, so this is not what makes the write path safe — it is what makes
    // the write path refuse for the *same reason* the read path does. Without it an unevaluable
    // filter reads as `invalid_intent` and writes as `not_found`, and the grant looks broken in
    // two different ways depending on which verb you try.
    if (validateDocumentFilters(grant.documentFilter, c))
      return audit.refuseMutation(intent, grant, "invalid_intent");

    // Phase 5: proposal_only mode creates pending revisions for dataset collections.
    // File collections are append-only; they don't support this mode.
    if (grant.mode === "proposal_only") {
      // proposal_only parks a write as a PENDING REVISION, and a kind with no revisions has
      // nowhere to park it.
      if (kindOf(c).chunked) return audit.refuse(intent.collection, "verb_denied", { grant });
      return proposeDataset(d, ctx, audit, intent, c, grant);
    }

    // Write pool: env determines which pool; no pool configured → not_writable
    const pool = writePool(pools, ctx);
    if (!pool) return audit.refuse(intent.collection, "not_writable", { grant });

    // The field that ADDRESSES a document rather than describing it: the declared pk for a
    // dataset, `path` for a file. It is exempt from the write posture on create, because a
    // create has to be able to name what it is creating — and requiring `write: allow` on a pk
    // would say the opposite of what is true, namely that identity may later be changed.
    // On update and delete it is not accepted at all: changing identity is not an edit.
    const identityField = kindOf(c).identityField(c);

    const all = Object.keys(c.fields);
    for (const f of fieldNames) {
      if (!all.includes(f)) return audit.refuseMutation(intent, grant, "unknown_field");
      if (c.fields[f]!.view_join) return audit.refuseMutation(intent, grant, "field_not_writable");
      if (f === identityField) {
        if (intent.op !== "create")
          return audit.refuseMutation(intent, grant, "field_not_writable");
        continue; // identity on create: addressed above, and never posture-gated
      }
      if (writePosture(c.fields[f]!) !== "allow")
        return audit.refuseMutation(intent, grant, "field_not_writable");
      if (!grant.allowedFields.includes(f))
        return audit.refuseMutation(intent, grant, "field_denied");
    }

    // A chunked kind stores a file plus its derived chunks; a dataset stores one revision.
    if (kindOf(c).chunked) {
      return mutateFile(d, ctx, audit, intent, c, grant, pool);
    }

    // Dataset collection handling
    return mutateDataset(ctx, audit, intent, c, grant, pool);
  };
}

// A file collection is a record of what was INGESTED, so it only ever grows: create appends
// a file row plus its derived chunks, and `path` being unique makes a repeat a conflict
// rather than a silent overwrite. Chunks are derived once here and never re-derived, which
// is why the "search still returns pre-edit text" bug class cannot occur for files.
async function mutateFile(
  d: VerbDeps,
  ctx: BrokerContext,
  audit: AuditWriter,
  intent: MutationIntent,
  c: CollectionConfig,
  grant: ActiveGrant,
  pool: Pool,
): Promise<MutationResult> {
  // Structural, and checked before anything else: no grant can make a file revisable.
  if (intent.op !== "create") return audit.refuseMutation(intent, grant, "verb_not_supported");

  const values = intent.values;
  const path = typeof values.path === "string" ? values.path.trim() : "";
  const content = typeof values.content === "string" ? values.content : "";
  if (!path || !content) return audit.refuseMutation(intent, grant, "invalid_intent");

  const coerced: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const r = coerce(value, c.fields[name]!);
    if (!r.ok) return audit.refuseMutation(intent, grant, "invalid_value");
    coerced[name] = r.value;
  }

  // A term outside the bound vocabulary is a value error, exactly as it is on import.
  // A dataset-sourced vocabulary keeps its terms in env-scoped `app.terms`, which this path
  // has not read, so it is unvalidatable here and refused — the same closed default
  // import/validate.ts takes when the caller supplies no bindings.
  for (const vocabSlug of c.taxonomies ?? []) {
    if (!(vocabSlug in values)) continue;
    const vocab = d.cfg.taxonomies[vocabSlug];
    if (!vocab?.terms) return audit.refuseMutation(intent, grant, "invalid_value");
    // A `multiple: true` vocabulary carries a list; every part is validated independently.
    const submitted = Array.isArray(values[vocabSlug])
      ? (values[vocabSlug] as unknown[])
      : [values[vocabSlug]];
    for (const t of submitted) {
      // A client-supplied term. A non-scalar stringifies to "[object Object]", which is not a term
      // slug, so the refusal below is reached — the placeholder never leaves this expression.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const term = String(t ?? "");
      if (!Object.hasOwn(vocab.terms, term))
        return audit.refuseMutation(intent, grant, "invalid_value");
    }
  }

  const chunks = chunkText(content);
  if (chunks.length === 0) return audit.refuseMutation(intent, grant, "invalid_intent");

  const schema = dataSchema(ctx.env);
  const files = `${schema}.${ident(`${intent.collection}__files`)}`;
  const docs = `${schema}.${ident(`${intent.collection}__documents`)}`;
  // The same checksum the indexer stores, so a file created through the API and one indexed
  // from disk are indistinguishable downstream.
  const checksum = createHash("sha256").update(content).digest("hex");

  try {
    return await withWorkspace(pool, ctx.workspaceId, async (client) => {
      // No pre-check for an existing path: the write role holds INSERT and nothing else on
      // file tables, keeping "write-only means write-only" true for them the way it is for
      // the import role. The unique index on `path` is what answers, and a 23505 below
      // becomes `conflict` — which also closes the race a pre-check would leave open.
      const fileId = randomUUID();
      const cols = ["id", "workspace_id", "path", "title", "owner", "checksum", "updated_at"];
      const vals: unknown[] = [
        fileId,
        ctx.workspaceId,
        path,
        coerced.title ?? null,
        coerced.owner ?? null,
        checksum,
        coerced.updated_at ?? new Date(),
      ];
      for (const vocabSlug of c.taxonomies ?? []) {
        cols.push(vocabSlug);
        vals.push(coerced[vocabSlug] ?? null);
      }
      await client.query(
        `insert into ${files} (${cols.map(ident).join(", ")})
         values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
        vals,
      );

      for (const [seq, chunk] of chunks.entries())
        await client.query(
          `insert into ${docs} (id, file_id, workspace_id, document_seq, content) values ($1,$2,$3,$4,$5)`,
          [randomUUID(), fileId, ctx.workspaceId, seq, chunk],
        );

      // For files, store the file_id as the rev identifier in change_log; the checksum is
      // returned to the caller as the If-Match value but is not a UUID for storage.
      await writeChangeLog(client, ctx, intent.collection, fileId, fileId, "create", "approved");
      const rec = await audit.allowMutation(intent, grant, Object.keys(values));
      assertRecorded(rec);
      // A file has no revisions, so its checksum is the closest thing to one: it identifies
      // the content that was stored, and it is what a later If-Match would compare.
      return {
        ok: true as const,
        status: "applied" as const,
        documentId: fileId,
        rev: checksum,
        auditId: rec.auditId,
      };
    });
  } catch (err) {
    // 23505 on this table can only be the unique `path`: the caller is re-creating a
    // document that already exists, which is a conflict rather than a server fault.
    if ((err as { code?: string }).code === "23505")
      return audit.refuseMutation(intent, grant, "conflict");
    console.error("[broker] mutateFile failed", { collection: intent.collection, err });
    return audit.refuseMutation(intent, grant, "internal_error");
  }
}

async function mutateDataset(
  ctx: BrokerContext,
  audit: AuditWriter,
  intent: MutationIntent,
  c: CollectionConfig,
  grant: ActiveGrant,
  pool: Pool,
): Promise<MutationResult> {
  const schema = dataSchema(ctx.env);
  const table = `${schema}.${ident(intent.collection)}`;
  const pk = pkOf(c);
  // Without a declared pk a dataset has no document identity, so nothing can address it.
  if (!pk) return audit.refuseMutation(intent, grant, "invalid_intent");

  const submitted = intent.op === "delete" ? {} : intent.values;
  const coerced: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(submitted)) {
    const r = coerce(value, c.fields[name]!);
    // coerce's reasons name a type; the broker's name nothing. Collapse them.
    if (!r.ok) return audit.refuseMutation(intent, grant, "invalid_value");
    coerced[name] = r.value;
  }

  // Storable columns, in one fixed order shared by every insert below.
  const dataCols = dataColsOf(c);
  const actor = { by: ctx.userId, workspaceId: ctx.workspaceId };

  try {
    return await withWorkspace(pool, ctx.workspaceId, async (client) => {
      if (intent.op === "create") {
        let docId = coerced[pk];
        if (docId === undefined && c.fields[pk]!.type === "uuid") {
          docId = randomUUID();
          coerced[pk] = docId;
        }
        if (docId === undefined) return audit.refuseMutation(intent, grant, "invalid_intent");
        // The pk value came out of `coerced`, whose values are `unknown` to the compiler. Anything
        // non-scalar would stringify to "[object Object]"; it is a pk, so it is a scalar — but say
        // that once, here, rather than at each use.
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const documentId = String(docId);

        // Check first so the caller gets a reason code; the partial unique index is the
        // backstop if two creates race.
        const clash = await client.query(
          `select 1 from ${table} where ${ident(pk)} = $1 and _current`,
          [docId],
        );
        if ((clash.rowCount ?? 0) > 0) return audit.refuseMutation(intent, grant, "conflict");

        const revId = await insertRevision(
          client,
          table,
          dataCols,
          {
            seq: 1,
            op: "create",
            status: "approved",
            fields: Object.keys(coerced),
            base: null,
            current: true,
            ...actor,
          },
          coerced,
        );
        await writeChangeLog(
          client,
          ctx,
          intent.collection,
          documentId,
          revId,
          "create",
          "approved",
        );
        const rec = await audit.allowMutation(intent, grant, Object.keys(coerced));
        assertRecorded(rec);
        return {
          ok: true as const,
          status: "applied" as const,
          documentId,
          rev: revId,
          auditId: rec.auditId,
        };
      }

      // update and delete both revise an existing document, and differ only in the op they
      // record and whether they carry values.
      // The row carries its ACL: same statement, same transaction, so there is no window
      // between reading the document and reading the policy that governs it.
      const current = await currentRevision(
        client,
        table,
        pk,
        intent.id,
        aclColumnSql(ctx.env, intent.collection, c, "t"),
      );
      if (!current) return audit.refuseMutation(intent, grant, "not_found");

      // A document the grant's filter OR its ACL excludes is not_found, never a distinct refusal —
      // the same rule as getDocument. $self is already bound by loadActiveGrant.
      if (!admits(current, grant, c)) return audit.refuseMutation(intent, grant, "not_found");

      // Optimistic concurrency: `expect` is the _rev the caller last saw.
      if (intent.expect && intent.expect !== current._rev)
        return audit.refuseMutation(intent, grant, "conflict");

      const isDelete = intent.op === "delete";
      // Demote-then-promote, untouched columns carried forward: reviseDocument owns both, and is
      // the same call the import path makes, so the two cannot drift.
      const revId = await reviseDocument(client, table, dataCols, current, coerced, {
        op: isDelete ? "delete" : "update",
        status: "approved",
        ...actor,
      });

      await writeChangeLog(
        client,
        ctx,
        intent.collection,
        String(intent.id),
        revId,
        isDelete ? "delete" : "update",
        "approved",
      );
      const rec = await audit.allowMutation(intent, grant, isDelete ? [] : Object.keys(coerced));
      assertRecorded(rec);
      return {
        ok: true as const,
        status: "applied" as const,
        documentId: String(intent.id),
        rev: revId,
        auditId: rec.auditId,
      };
    });
  } catch (err) {
    // Same discipline as query: a driver error names columns and values, so it goes to the
    // log and the caller gets a bare reason code.
    console.error("[broker] mutateDataset failed", { collection: intent.collection, err });
    return audit.refuseMutation(intent, grant, "internal_error");
  }
}
