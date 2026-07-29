import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  BrokerContext, QueryIntent, DocSearchIntent, BrokerResult, RefusalReason, VisibleSchema, Refusal,
  GetDocumentIntent, GetDocumentResult, Document, Filter, DocumentFilter,
  MutationIntent, MutationResult, MutationRefusalReason,
} from "./types";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./types";
import type { WarehousdConfig } from "./config/schema";
import type { ActiveGrant } from "./grants/eval";
import type { Pools } from "./db/pools";
import { dataPool, withOrg, writePool } from "./db/pools";
import { loadActiveGrant } from "./grants/eval";
import { buildSelect, UnsupportedFilter } from "./sql/build";
import { writeAudit } from "./audit/write";
import { findCollection, supportedVerbs } from "./config/load";
import { reassembleChunks, chunkText } from "./indexing/chunk";
import { writePosture } from "./config/schema";
import { coerce } from "./import/validate";

// The parsed shape of one collection, as CollectionSchema produces it.
type CollectionConfig = WarehousdConfig["collections"][string];

export function makeBroker(pools: Pools, cfg: WarehousdConfig) {
  const app = pools.app;

  async function refuse(ctx: BrokerContext, collection: string, intent: QueryIntent | DocSearchIntent | null,
    reason: RefusalReason, grantId: string | null = null): Promise<Refusal> {
    const auditId = await writeAudit(app, {
      userId: ctx.userId, env: ctx.env, collection, orgId: ctx.orgId, intent,
      fieldsReturned: [], grantId, outcome: "refused", reason, via: ctx.via });
    return { ok: false, reason, auditId };
  }

  function fieldsOf(collection: string): string[] | null {
    const c = findCollection(cfg, collection);
    return c ? Object.keys(c.fields) : null;
  }

  // A term field bound to a `multiple: true` vocabulary is a text[] column (apply/ddl.ts), so
  // buildSelect has to reach for `&&`/`= any` rather than `in`/`=`. Omitting this makes it
  // compare text[] against text, which Postgres rejects outright.
  // `taxonomies` is optional-chained, not indexed: callers that hand-build a config object and
  // cast it never get zod's default, so the key is genuinely absent for most of the test suite.
  const isMultiValueField = (field: string) => cfg.taxonomies?.[field]?.multiple ?? false;

  // A mutation's audit intent records the op and the field NAMES it touched — never the
  // submitted values. This is a deliberate departure from query, whose intent is safe to store
  // verbatim: a write payload can carry real personal data, and an audit row is readable by
  // every admin in the UI.
  const mutationIntent = (i: MutationIntent, fields: string[]) => ({
    op: i.op, collection: i.collection, id: "id" in i ? i.id : undefined, fields,
  });

  function auditMutation(ctx: BrokerContext, i: MutationIntent, grantId: string | null, fields: string[]) {
    return writeAudit(app, {
      userId: ctx.userId, env: ctx.env, collection: i.collection, orgId: ctx.orgId,
      intent: mutationIntent(i, fields) as never,
      fieldsReturned: [], grantId, outcome: "allowed", reason: null, via: ctx.via });
  }

  async function refuseMutation(
    ctx: BrokerContext, i: MutationIntent, grantId: string | null, reason: MutationRefusalReason,
  ): Promise<MutationResult> {
    const auditId = await writeAudit(app, {
      userId: ctx.userId, env: ctx.env, collection: i.collection, orgId: ctx.orgId,
      intent: mutationIntent(i, i.op === "delete" ? [] : Object.keys(i.values)) as never,
      fieldsReturned: [], grantId, outcome: "refused", reason, via: ctx.via });
    return { ok: false, reason, auditId };
  }

  async function query(ctx: BrokerContext, intent: QueryIntent): Promise<BrokerResult> {
    // 1. intent shape
    if (intent.aggregate && intent.aggregate.length && intent.fields && intent.fields.length)
      return refuse(ctx, intent.collection, intent, "invalid_intent");
    // 2. collection exists
    const all = fieldsOf(intent.collection);
    if (!all) return refuse(ctx, intent.collection, intent, "unknown_collection");
    // every referenced field must exist on the collection at all
    const referenced = collectReferenced(intent);
    for (const f of referenced) if (!all.includes(f))
      return refuse(ctx, intent.collection, intent, "unknown_field");
    // 3. active grant
    const grant = await loadActiveGrant(app, ctx, intent.collection);
    if (!grant) return refuse(ctx, intent.collection, intent, "no_grant");
    // No read verb → no_grant (not a new code; §4 comment on information leak)
    if (!grant.verbs.includes("read")) return refuse(ctx, intent.collection, intent, "no_grant");
    // 4. every referenced field ∈ grant.allowedFields
    for (const f of referenced) if (!grant.allowedFields.includes(f))
      return refuse(ctx, intent.collection, intent, "field_denied", grant.id);
    // document_filter is grant-author-supplied; each predicate's field is validated against
    // the collection's full YAML field set (NOT allowedFields) so denied fields like `path` can gate documents.
    for (const f of grant.documentFilter) {
      if (!all.includes(f.field))
        return refuse(ctx, intent.collection, intent, "invalid_intent", grant.id);
    }
    // fields to select: explicit, else all granted fields present on the collection
    const selectFields = intent.fields && intent.fields.length
      ? intent.fields
      : grant.allowedFields.filter((f) => all.includes(f));
    // 5. build + execute on the env-scoped pool through withOrg transaction
    try {
      const { text, values } = buildSelect(ctx.env, intent, grant.allowedFields,
        { documentFilters: grant.documentFilter, isMultiValueField });
      const documents = await withOrg(dataPool(pools, ctx), ctx.orgId, async (client: PoolClient) => {
        return (await client.query(text, values)).rows;
      });
      const fieldsReturned = intent.aggregate && intent.aggregate.length
        ? [...(intent.groupBy ?? []), ...intent.aggregate.map((a) => `${a.fn}_${a.field}`)]
        : selectFields;
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId, intent,
        fieldsReturned, grantId: grant.id, outcome: "allowed", reason: null, via: ctx.via });
      return { ok: true, documents, fieldsReturned, auditId };
    } catch (err) {
      // A filter the builder can't express is the caller's mistake, not ours. It carries no
      // driver detail, so answering invalid_intent tells them something actionable.
      if (err instanceof UnsupportedFilter)
        return refuse(ctx, intent.collection, intent, "invalid_intent", grant?.id ?? null);
      // Never surface a raw driver error: Postgres messages name columns, tables and
      // values, which is exactly what §10 test 4 forbids leaking. The audit row is
      // the non-negotiable part — an unaudited probe leaves no trace.
      console.error("[broker] query failed", { collection: intent.collection, err });
      return refuse(ctx, intent.collection, intent, "internal_error", grant?.id ?? null);
    }
  }

  async function describeCollection(ctx: BrokerContext, name: string): Promise<VisibleSchema | Refusal> {
    const c = findCollection(cfg, name);
    if (!c) return refuse(ctx, name, null, "unknown_collection");
    const grant = await loadActiveGrant(app, ctx, name);
    if (!grant) return refuse(ctx, name, null, "no_grant");
    if (!grant.verbs.includes("read")) return refuse(ctx, name, null, "no_grant");
    const fields = Object.entries(c.fields)
      .filter(([n]) => grant.allowedFields.includes(n))
      // type is guaranteed by CollectionSchema refinement for structured collections; file collections have types filled in by transform
      // A multi-value term field is pinned to `text` in config so the schema stays simple, but
      // the column is text[]. Report what the caller will actually be querying, or they write a
      // scalar filter against an array and get a refusal they can't diagnose.
      .map(([n, f]) => ({ name: n, type: isMultiValueField(n) ? "text[]" : f.type!, pk: f.pk }));
    await writeAudit(app, { userId: ctx.userId, env: ctx.env, collection: name, orgId: ctx.orgId, intent: null,
      fieldsReturned: fields.map((f) => f.name), grantId: grant.id, outcome: "allowed", reason: null, via: ctx.via });
    return { collection: name, description: c.description, fields };
  }

  async function listCollections(ctx: BrokerContext): Promise<{ name: string; description: string }[]> {
    const collections = Object.entries(cfg.collections).map(([name, c]) => ({ name, description: c.description }));
    await writeAudit(app, {
      userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId, intent: null,
      fieldsReturned: [], grantId: null, outcome: "allowed", reason: null, via: ctx.via });
    return collections;
  }

  async function searchDocuments(ctx: BrokerContext, intent: DocSearchIntent): Promise<BrokerResult> {
    const c = findCollection(cfg, intent.collection);
    if (!c) return refuse(ctx, intent.collection, intent, "unknown_collection");
    if (typeof intent.q !== "string" || !intent.q.trim())
      return refuse(ctx, intent.collection, intent, "invalid_intent");

    // Check if searchable: file collections always support search (via tsv column);
    // dataset collections need at least one searchable: true field
    const isFile = c.type === "file";
    const searchableFields = isFile ? [] : Object.entries(c.fields)
      .filter(([, f]) => f.searchable === true).map(([n]) => n);
    if (!isFile && searchableFields.length === 0)
      return refuse(ctx, intent.collection, intent, "invalid_intent");

    const all = Object.keys(c.fields);
    for (const f of intent.fields ?? []) if (!all.includes(f))
      return refuse(ctx, intent.collection, intent, "unknown_field");
    const grant = await loadActiveGrant(app, ctx, intent.collection);
    if (!grant) return refuse(ctx, intent.collection, intent, "no_grant");
    if (!grant.verbs.includes("read")) return refuse(ctx, intent.collection, intent, "no_grant");
    for (const f of intent.fields ?? []) if (!grant.allowedFields.includes(f))
      return refuse(ctx, intent.collection, intent, "field_denied", grant.id);
    for (const f of grant.documentFilter) {
      if (!all.includes(f.field))
        return refuse(ctx, intent.collection, intent, "invalid_intent", grant.id);
    }
    const selectFields = intent.fields && intent.fields.length
      ? intent.fields : grant.allowedFields.filter((f) => all.includes(f));
    try {
      const { text, values } = buildSelect(ctx.env,
        { collection: intent.collection, fields: selectFields, limit: intent.limit, offset: intent.offset } as QueryIntent,
        grant.allowedFields,
        { q: intent.q, documentFilters: grant.documentFilter, isMultiValueField,
          searchFields: searchableFields });
      const documents = await withOrg(dataPool(pools, ctx), ctx.orgId, async (client: PoolClient) => {
        return (await client.query(text, values)).rows;
      });
      const auditId = await writeAudit(app, { userId: ctx.userId, env: ctx.env,
        collection: intent.collection, orgId: ctx.orgId, intent, fieldsReturned: selectFields,
        grantId: grant.id, outcome: "allowed", reason: null, via: ctx.via });
      return { ok: true, documents, fieldsReturned: selectFields, auditId };
    } catch (err) {
      // Never surface a raw driver error: Postgres messages name columns, tables and
      // values, which is exactly what §10 test 4 forbids leaking. The audit row is
      // the non-negotiable part — an unaudited probe leaves no trace.
      console.error("[broker] searchDocuments failed", { collection: intent.collection, err });
      return refuse(ctx, intent.collection, intent, "internal_error", grant.id);
    }
  }

  // The full-document read. It shares query's prologue deliberately — same grant, same read
  // verb, same field postures, same document filter — and differs only in how the target is
  // addressed and, for file collections, in reassembling the chunks back into one document.
  async function getDocument(ctx: BrokerContext, intent: GetDocumentIntent): Promise<GetDocumentResult> {
    const c = findCollection(cfg, intent.collection);
    if (!c) return refuse(ctx, intent.collection, null, "unknown_collection");
    const isFile = c.type === "file";
    const byPath = "path" in intent;
    // A path addresses a source file; a dataset has none.
    if (byPath && !isFile) return refuse(ctx, intent.collection, null, "invalid_intent");

    const grant = await loadActiveGrant(app, ctx, intent.collection);
    if (!grant) return refuse(ctx, intent.collection, null, "no_grant");
    if (!grant.verbs.includes("read")) return refuse(ctx, intent.collection, null, "no_grant");

    const all = Object.keys(c.fields);
    for (const f of grant.documentFilter) {
      if (!all.includes(f.field))
        return refuse(ctx, intent.collection, null, "invalid_intent", grant.id);
    }

    // How the caller names the document. Like documentFilter this is broker-supplied rather
    // than client-supplied, so it may reference a column outside allowedFields — a file's
    // `path` is commonly posture:deny yet is exactly how you address the file.
    let key: Filter;
    if (isFile) {
      key = byPath
        ? { field: "path", op: "eq", value: (intent as { path: string }).path }
        : { field: "file_id", op: "eq", value: (intent as { id: string }).id };
    } else {
      const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
      // Without a declared pk there is no document identity to address by id.
      if (!pk) return refuse(ctx, intent.collection, null, "invalid_intent", grant.id);
      key = { field: pk, op: "eq", value: (intent as { id: string }).id };
    }

    const selectFields = grant.allowedFields.filter((f) => all.includes(f));

    try {
      // One file yields many documents, so the file form fetches every chunk in order and
      // rejoins them. A dataset document is a single row.
      const shaped: QueryIntent = isFile
        ? { collection: intent.collection, fields: selectFields, filters: [key],
            orderBy: { field: "document_seq", dir: "asc" }, limit: MAX_LIMIT }
        : { collection: intent.collection, fields: selectFields, filters: [key], limit: 1 };

      const { text, values } = buildSelect(ctx.env, shaped, grant.allowedFields,
        { documentFilters: grant.documentFilter, isMultiValueField });
      const rows = await withOrg(dataPool(pools, ctx), ctx.orgId,
        async (client: PoolClient) => (await client.query(text, values)).rows);

      // Absent and excluded-by-filter are the same answer. Distinguishing them would make this
      // an existence oracle for documents the grant deliberately hides.
      if (rows.length === 0) {
        const auditId = await writeAudit(app, {
          userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
          intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "not_found", via: ctx.via });
        return { ok: false, reason: "not_found", auditId };
      }

      const document: Document = { ...rows[0] };
      if (isFile && selectFields.includes("content"))
        document.content = reassembleChunks(rows.map((r) => String(r.content ?? "")));

      // _rev only exists on writable collections (dataset type with revisions tracking).
      // Fetch it separately because it's a system field, not a granted field, and it's needed
      // for concurrency control (ETag/If-Match). It identifies the document's current state
      // for the caller, which is not a field-value disclosure — like MutationResult.rev.
      // Fetch through writePool (read role cannot see base tables, only views which exclude _rev).
      // Like listRevisions and listProposals, this gracefully degrades if no write pool exists.
      let rev: string | undefined;
      if (c.writable && !isFile) {
        const pool = writePool(pools, ctx);
        if (pool) {
          const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
          if (pk) {
            const schema = ctx.env === "live" ? "data_live" : "data_synth";
            const revQuery = await withOrg(pool, ctx.orgId,
              async (client: PoolClient) => {
                const r = await client.query(`select _rev from ${schema}.${ident(intent.collection)} where ${ident(pk)} = $1 and _current`, [(intent as { id: string }).id]);
                return r.rows[0]?._rev;
              });
            rev = revQuery;
          }
        }
      }

      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: selectFields, grantId: grant.id, outcome: "allowed", reason: null, via: ctx.via });
      return { ok: true, document, fieldsReturned: selectFields, rev, auditId };
    } catch (err) {
      // Same discipline as query: a driver error names columns and values, so it goes to the
      // log and the caller gets a bare reason code. The audit row is written either way.
      console.error("[broker] getDocument failed", { collection: intent.collection, err });
      return refuse(ctx, intent.collection, null, "internal_error", grant.id);
    }
  }
  async function mutate(ctx: BrokerContext, intent: MutationIntent): Promise<MutationResult> {
    const values = intent.op !== "delete" ? intent.values : {};
    const fieldNames = Object.keys(values);

    // 1. intent shape
    if (intent.op === "create" && !fieldNames.length && !intent.values)
      return refuse(ctx, intent.collection, null, "invalid_intent");
    if ((intent.op === "update" || intent.op === "delete") && !intent.id)
      return refuse(ctx, intent.collection, null, "invalid_intent");

    // 2. collection exists
    const c = findCollection(cfg, intent.collection);
    if (!c) return refuse(ctx, intent.collection, null, "unknown_collection");

    // 3. collection is writable
    if (!c.writable) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "not_writable", via: ctx.via });
      return { ok: false, reason: "not_writable", auditId };
    }

    // 4. op supported for this collection type
    const supported = supportedVerbs(cfg, intent.collection);
    if (!supported.includes(intent.op)) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "verb_not_supported", via: ctx.via });
      return { ok: false, reason: "verb_not_supported", auditId };
    }

    // 5. active grant
    const grant = await loadActiveGrant(app, ctx, intent.collection);
    if (!grant) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "no_grant", via: ctx.via });
      return { ok: false, reason: "no_grant", auditId };
    }

    // 6. verb ∈ grant.verbs
    if (!grant.verbs.includes(intent.op)) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "verb_denied", via: ctx.via });
      return { ok: false, reason: "verb_denied", auditId };
    }

    // Phase 5: proposal_only mode creates pending revisions for dataset collections.
    // File collections are append-only; they don't support this mode.
    if (grant.mode === "proposal_only") {
      if (c.type === "file") {
        const auditId = await writeAudit(app, {
          userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
          intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "verb_denied", via: ctx.via });
        return { ok: false, reason: "verb_denied", auditId };
      }
      return proposeDataset(ctx, intent, c, grant, pools, app);
    }

    // Write pool: env determines which pool; no pool configured → not_writable
    const pool = writePool(pools, ctx);
    if (!pool) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "not_writable", via: ctx.via });
      return { ok: false, reason: "not_writable", auditId };
    }

    // The field that ADDRESSES a document rather than describing it: the declared pk for a
    // dataset, `path` for a file. It is exempt from the write posture on create, because a
    // create has to be able to name what it is creating — and requiring `write: allow` on a pk
    // would say the opposite of what is true, namely that identity may later be changed.
    // On update and delete it is not accepted at all: changing identity is not an edit.
    const identityField = c.type === "file"
      ? "path"
      : Object.entries(c.fields).find(([, f]) => f.pk)?.[0];

    const all = Object.keys(c.fields);
    for (const f of fieldNames) {
      if (!all.includes(f))
        return refuseMutation(ctx, intent, grant.id, "unknown_field");
      if (c.fields[f]!.view_join)
        return refuseMutation(ctx, intent, grant.id, "field_not_writable");
      if (f === identityField) {
        if (intent.op !== "create")
          return refuseMutation(ctx, intent, grant.id, "field_not_writable");
        continue;   // identity on create: addressed above, and never posture-gated
      }
      if (writePosture(c.fields[f]!) !== "allow")
        return refuseMutation(ctx, intent, grant.id, "field_not_writable");
      if (!grant.allowedFields.includes(f))
        return refuseMutation(ctx, intent, grant.id, "field_denied");
    }

    // File collection handling
    if (c.type === "file") {
      return mutateFile(ctx, intent, c, grant, pool);
    }

    // Dataset collection handling
    return mutateDataset(ctx, intent, c, grant, pool);
  }

  // A file collection is a record of what was INGESTED, so it only ever grows: create appends
  // a file row plus its derived chunks, and `path` being unique makes a repeat a conflict
  // rather than a silent overwrite. Chunks are derived once here and never re-derived, which
  // is why the "search still returns pre-edit text" bug class cannot occur for files.
  async function mutateFile(
    ctx: BrokerContext, intent: MutationIntent, c: CollectionConfig, grant: ActiveGrant, pool: Pool,
  ): Promise<MutationResult> {
    // Structural, and checked before anything else: no grant can make a file revisable.
    if (intent.op !== "create") return refuseMutation(ctx, intent, grant.id, "verb_not_supported");

    const values = intent.values;
    const path = typeof values.path === "string" ? values.path.trim() : "";
    const content = typeof values.content === "string" ? values.content : "";
    if (!path || !content) return refuseMutation(ctx, intent, grant.id, "invalid_intent");

    const coerced: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values)) {
      const r = coerce(value, c.fields[name]!);
      if (!r.ok) return refuseMutation(ctx, intent, grant.id, "invalid_value");
      coerced[name] = r.value;
    }

    // A term outside the bound vocabulary is a value error, exactly as it is on import.
    // A dataset-sourced vocabulary keeps its terms in env-scoped `app.terms`, which this path
    // has not read, so it is unvalidatable here and refused — the same closed default
    // import/validate.ts takes when the caller supplies no bindings.
    for (const vocabSlug of c.taxonomies ?? []) {
      if (!(vocabSlug in values)) continue;
      const vocab = cfg.taxonomies[vocabSlug];
      if (!vocab?.terms) return refuseMutation(ctx, intent, grant.id, "invalid_value");
      // A `multiple: true` vocabulary carries a list; every part is validated independently.
      const submitted = Array.isArray(values[vocabSlug]) ? values[vocabSlug] as unknown[] : [values[vocabSlug]];
      for (const t of submitted)
        if (!Object.hasOwn(vocab.terms, String(t ?? "")))
          return refuseMutation(ctx, intent, grant.id, "invalid_value");
    }

    const chunks = chunkText(content);
    if (chunks.length === 0) return refuseMutation(ctx, intent, grant.id, "invalid_intent");

    const schema = ctx.env === "live" ? "data_live" : "data_synth";
    const files = `${schema}.${ident(`${intent.collection}__files`)}`;
    const docs = `${schema}.${ident(`${intent.collection}__documents`)}`;
    // The same checksum the indexer stores, so a file created through the API and one indexed
    // from disk are indistinguishable downstream.
    const checksum = createHash("sha256").update(content).digest("hex");

    try {
      return await withOrg(pool, ctx.orgId, async (client) => {
        // No pre-check for an existing path: the write role holds INSERT and nothing else on
        // file tables, keeping "write-only means write-only" true for them the way it is for
        // the import role. The unique index on `path` is what answers, and a 23505 below
        // becomes `conflict` — which also closes the race a pre-check would leave open.
        const fileId = randomUUID();
        const cols = ["id", "org_id", "path", "title", "owner", "checksum", "updated_at"];
        const vals: unknown[] = [fileId, ctx.orgId, path,
          coerced.title ?? null, coerced.owner ?? null, checksum,
          coerced.updated_at ?? new Date()];
        for (const vocabSlug of c.taxonomies ?? []) {
          cols.push(vocabSlug);
          vals.push(coerced[vocabSlug] ?? null);
        }
        await client.query(
          `insert into ${files} (${cols.map(ident).join(", ")})
           values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`, vals);

        for (const [seq, chunk] of chunks.entries())
          await client.query(
            `insert into ${docs} (id, file_id, org_id, document_seq, content) values ($1,$2,$3,$4,$5)`,
            [randomUUID(), fileId, ctx.orgId, seq, chunk]);

        // For files, store the file_id as the rev identifier in change_log; the checksum is
        // returned to the caller as the If-Match value but is not a UUID for storage.
        await writeChangeLog(client, ctx, intent.collection, fileId, fileId, "create", "approved");
        const auditId = await auditMutation(ctx, intent, grant.id, Object.keys(values));
        // A file has no revisions, so its checksum is the closest thing to one: it identifies
        // the content that was stored, and it is what a later If-Match would compare.
        return { ok: true as const, status: "applied" as const, documentId: fileId, rev: checksum, auditId };
      });
    } catch (err) {
      // 23505 on this table can only be the unique `path`: the caller is re-creating a
      // document that already exists, which is a conflict rather than a server fault.
      if ((err as { code?: string }).code === "23505")
        return refuseMutation(ctx, intent, grant.id, "conflict");
      console.error("[broker] mutateFile failed", { collection: intent.collection, err });
      return refuseMutation(ctx, intent, grant.id, "internal_error");
    }
  }

  async function mutateDataset(
    ctx: BrokerContext, intent: MutationIntent, c: CollectionConfig, grant: ActiveGrant, pool: Pool,
  ): Promise<MutationResult> {
    const schema = ctx.env === "live" ? "data_live" : "data_synth";
    const table = `${schema}.${ident(intent.collection)}`;
    const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
    // Without a declared pk a dataset has no document identity, so nothing can address it.
    if (!pk) return refuseMutation(ctx, intent, grant.id, "invalid_intent");

    const submitted = intent.op === "delete" ? {} : intent.values;
    const coerced: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(submitted)) {
      const r = coerce(value, c.fields[name]!);
      // coerce's reasons name a type; the broker's name nothing. Collapse them.
      if (!r.ok) return refuseMutation(ctx, intent, grant.id, "invalid_value");
      coerced[name] = r.value;
    }

    // Storable columns, in one fixed order shared by every insert below.
    const dataCols = Object.entries(c.fields).filter(([, f]) => !f.view_join).map(([n]) => n);
    const REV_COLS = ["_rev", "_rev_seq", "_rev_at", "_rev_by", "_rev_op", "_rev_status",
      "_rev_fields", "_rev_base", "_current", "org_id"];

    const insertRevision = async (
      client: PoolClient,
      rev: { seq: number; op: string; fields: string[]; base: number | null; current: boolean },
      row: Record<string, unknown>,
    ): Promise<string> => {
      const revId = randomUUID();
      const cols = [...REV_COLS, ...dataCols].map(ident).join(", ");
      const vals: unknown[] = [revId, rev.seq, new Date(), ctx.userId, rev.op, "approved",
        rev.fields, rev.base, rev.current, ctx.orgId, ...dataCols.map((k) => row[k] ?? null)];
      await client.query(
        `insert into ${table} (${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
      return revId;
    };

    try {
      return await withOrg(pool, ctx.orgId, async (client) => {
        if (intent.op === "create") {
          let docId = coerced[pk];
          if (docId === undefined && c.fields[pk]!.type === "uuid") {
            docId = randomUUID();
            coerced[pk] = docId;
          }
          if (docId === undefined) return refuseMutation(ctx, intent, grant.id, "invalid_intent");

          // Check first so the caller gets a reason code; the partial unique index is the
          // backstop if two creates race.
          const clash = await client.query(
            `select 1 from ${table} where ${ident(pk)} = $1 and _current`, [docId]);
          if ((clash.rowCount ?? 0) > 0) return refuseMutation(ctx, intent, grant.id, "conflict");

          const revId = await insertRevision(client,
            { seq: 1, op: "create", fields: Object.keys(coerced), base: null, current: true }, coerced);
          await writeChangeLog(client, ctx, intent.collection, String(docId), revId, "create", "approved");
          const auditId = await auditMutation(ctx, intent, grant.id, Object.keys(coerced));
          return { ok: true as const, status: "applied" as const, documentId: String(docId), rev: revId, auditId };
        }

        // update and delete both revise an existing document, and differ only in the op they
        // record and whether they carry values.
        const cur = await client.query(
          `select * from ${table} where ${ident(pk)} = $1 and _current`, [intent.id]);
        if (cur.rowCount === 0) return refuseMutation(ctx, intent, grant.id, "not_found");
        const current = cur.rows[0]!;

        // A document the grant's filter excludes is not_found, never a distinct refusal —
        // the same rule as getDocument. $self is already bound by loadActiveGrant.
        if (!matchesFilters(current, grant.documentFilter))
          return refuseMutation(ctx, intent, grant.id, "not_found");

        // Optimistic concurrency: `expect` is the _rev the caller last saw.
        if (intent.expect && intent.expect !== current._rev)
          return refuseMutation(ctx, intent, grant.id, "conflict");

        const isDelete = intent.op === "delete";
        // Untouched columns carry forward, so a revision is a complete document, not a patch.
        const next: Record<string, unknown> = {};
        for (const f of dataCols) next[f] = f in coerced ? coerced[f] : current[f];

        // Demote the old revision BEFORE promoting the new one: both are _current between the
        // two statements otherwise, and the partial unique index would reject the insert.
        await client.query(`update ${table} set _current = false where _rev = $1`, [current._rev]);
        const revId = await insertRevision(client, {
          seq: Number(current._rev_seq) + 1,
          op: isDelete ? "delete" : "update",
          fields: isDelete ? [] : Object.keys(coerced),
          base: Number(current._rev_seq),
          current: true,
        }, next);

        await writeChangeLog(client, ctx, intent.collection, String(intent.id), revId, isDelete ? "delete" : "update", "approved");
        const auditId = await auditMutation(ctx, intent, grant.id, isDelete ? [] : Object.keys(coerced));
        return { ok: true as const, status: "applied" as const, documentId: String(intent.id), rev: revId, auditId };
      });
    } catch (err) {
      // Same discipline as query: a driver error names columns and values, so it goes to the
      // log and the caller gets a bare reason code.
      console.error("[broker] mutateDataset failed", { collection: intent.collection, err });
      return refuseMutation(ctx, intent, grant.id, "internal_error");
    }
  }

  async function proposeDataset(
    ctx: BrokerContext, intent: MutationIntent, c: CollectionConfig, grant: ActiveGrant, pools: Pools, appPool: Pool,
  ): Promise<MutationResult> {
    const schema = ctx.env === "live" ? "data_live" : "data_synth";
    const table = `${schema}.${ident(intent.collection)}`;
    const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
    if (!pk) return refuseMutation(ctx, intent, grant.id, "invalid_intent");

    const submitted = intent.op === "delete" ? {} : intent.values;
    const coerced: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(submitted)) {
      const r = coerce(value, c.fields[name]!);
      if (!r.ok) return refuseMutation(ctx, intent, grant.id, "invalid_value");
      coerced[name] = r.value;
    }

    const dataCols = Object.entries(c.fields).filter(([, f]) => !f.view_join).map(([n]) => n);
    const REV_COLS = ["_rev", "_rev_seq", "_rev_at", "_rev_by", "_rev_op", "_rev_status",
      "_rev_fields", "_rev_base", "_current", "org_id"];

    const pool = writePool(pools, ctx);
    if (!pool) return refuseMutation(ctx, intent, grant.id, "not_writable");

    try {
      return await withOrg(pool, ctx.orgId, async (client) => {
        if (intent.op === "create") {
          let docId = coerced[pk];
          if (docId === undefined && c.fields[pk]!.type === "uuid") {
            docId = randomUUID();
            coerced[pk] = docId;
          }
          if (docId === undefined) return refuseMutation(ctx, intent, grant.id, "invalid_intent");

          const clash = await client.query(
            `select 1 from ${table} where ${ident(pk)} = $1 and (_current or _rev_status = 'pending')`, [docId]);
          if ((clash.rowCount ?? 0) > 0) return refuseMutation(ctx, intent, grant.id, "conflict");

          const revId = randomUUID();
          const cols = [...REV_COLS, ...dataCols].map(ident).join(", ");
          const vals: unknown[] = [revId, 1, new Date(), ctx.userId, "create", "pending",
            Object.keys(coerced), null, false, ctx.orgId, ...dataCols.map((k) => coerced[k] ?? null)];
          await client.query(
            `insert into ${table} (${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`, vals);

          await writeChangeLog(client, ctx, intent.collection, String(docId), revId, "create", "pending");
          const auditId = await auditMutation(ctx, intent, grant.id, Object.keys(coerced));
          return { ok: true as const, status: "pending" as const, proposalId: revId, auditId };
        }

        // update and delete: fetch current revision and create pending
        const cur = await client.query(
          `select * from ${table} where ${ident(pk)} = $1 and _current`, [intent.id]);
        if (cur.rowCount === 0) return refuseMutation(ctx, intent, grant.id, "not_found");
        const current = cur.rows[0]!;

        if (!matchesFilters(current, grant.documentFilter))
          return refuseMutation(ctx, intent, grant.id, "not_found");

        const isDelete = intent.op === "delete";
        // For pending revisions, store the proposed changes in _rev_fields (the field names).
        // The data columns store the proposed state (the values).
        const next: Record<string, unknown> = {};
        for (const f of dataCols) next[f] = f in coerced ? coerced[f] : current[f];

        const revId = randomUUID();
        const cols = [...REV_COLS, ...dataCols].map(ident).join(", ");
        const vals: unknown[] = [revId, Number(current._rev_seq) + 1, new Date(), ctx.userId,
          isDelete ? "delete" : "update", "pending",
          isDelete ? [] : Object.keys(coerced),
          Number(current._rev_seq), false, ctx.orgId, ...dataCols.map((k) => next[k] ?? null)];
        await client.query(
          `insert into ${table} (${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`, vals);

        await writeChangeLog(client, ctx, intent.collection, String(intent.id), revId, isDelete ? "delete" : "update", "pending");
        const auditId = await auditMutation(ctx, intent, grant.id, isDelete ? [] : Object.keys(coerced));
        return { ok: true as const, status: "pending" as const, proposalId: revId, auditId };
      });
    } catch (err) {
      console.error("[broker] proposeDataset failed", { collection: intent.collection, err });
      return refuseMutation(ctx, intent, grant.id, "internal_error");
    }
  }

  // Approve and reject are deliberately NOT MCP tools — the untrusted model may propose,
  // but only an authenticated human may approve. Approval happens only through an authenticated
  // human surface. A future contributor should not add these as MCP tools.
  async function approveProposal(
    ctx: BrokerContext, proposalId: string,
  ): Promise<{ ok: true; documentId: string; rev: string; auditId: string } | { ok: false; reason: MutationRefusalReason; auditId: string }> {
    const schema = ctx.env === "live" ? "data_live" : "data_synth";

    // Find the proposal by proposalId
    const pool = writePool(pools, ctx);
    if (!pool) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "not_writable", via: ctx.via });
      return { ok: false, reason: "not_writable", auditId };
    }

    try {
      return await withOrg(pool, ctx.orgId, async (client) => {
        // Scan collections to find the proposal. Only revisable collections have a _rev
        // column at all — scanning the rest throws `column "_rev" does not exist`.
        const collections = revisableCollections(cfg);
        let proposal: any = null;
        let collectionName: string | null = null;

        for (const coll of collections) {
          const table = `${schema}.${ident(coll)}`;
          const q = await client.query(`select * from ${table} where _rev = $1 and _rev_status = 'pending'`, [proposalId]);
          if (q.rowCount && q.rowCount > 0) {
            proposal = q.rows[0];
            collectionName = coll;
            break;
          }
        }

        if (!proposal || !collectionName) {
          const auditId = await writeAudit(app, {
            userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId,
            intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "not_found", via: ctx.via });
          return { ok: false, reason: "not_found", auditId };
        }

        const c = findCollection(cfg, collectionName);
        if (!c) {
          const auditId = await writeAudit(app, {
            userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
            intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "unknown_collection", via: ctx.via });
          return { ok: false, reason: "unknown_collection", auditId };
        }

        // Load the approver's grant
        const grant = await loadActiveGrant(app, ctx, collectionName);
        if (!grant) {
          const auditId = await writeAudit(app, {
            userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
            intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "no_grant", via: ctx.via });
          return { ok: false, reason: "no_grant", auditId };
        }

        // Require approve verb
        if (!grant.verbs.includes("approve")) {
          const auditId = await writeAudit(app, {
            userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
            intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "verb_denied", via: ctx.via });
          return { ok: false, reason: "verb_denied", auditId };
        }

        // Invariant: approve requires read coverage of every field in the proposal. Without this,
        // "approve, then read the diff" is a privilege-escalation path around field postures.
        const proposedFields: string[] = proposal._rev_fields || [];
        for (const f of proposedFields) {
          if (!grant.allowedFields.includes(f)) {
            const auditId = await writeAudit(app, {
              userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
              intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "field_denied", via: ctx.via });
            return { ok: false, reason: "field_denied", auditId };
          }
        }

        // Get the pk field for this collection
        const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
        if (!pk) {
          const auditId = await writeAudit(app, {
            userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
            intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "invalid_intent", via: ctx.via });
          return { ok: false, reason: "invalid_intent", auditId };
        }

        const table = `${schema}.${ident(collectionName)}`;

        // Check document filter for approver
        let currentRev: any = null;
        if (proposal._rev_op === "create") {
          // For create proposals, there's no current revision yet. We need to check if the proposed
          // values would pass the filter. For now, we'll build a temporary object to check.
          const tempDoc: Record<string, unknown> = {};
          for (const f of Object.keys(c.fields)) {
            tempDoc[f] = proposal[f];
          }
          if (!matchesFilters(tempDoc, grant.documentFilter)) {
            const auditId = await writeAudit(app, {
              userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
              intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "not_found", via: ctx.via });
            return { ok: false, reason: "not_found", auditId };
          }
        } else {
          // For update/delete, fetch the current revision
          currentRev = await client.query(
            `select * from ${table} where ${ident(pk)} = $1 and _current`,
            [proposal[pk]]);
          if (!currentRev.rows || currentRev.rows.length === 0) {
            const auditId = await writeAudit(app, {
              userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
              intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "not_found", via: ctx.via });
            return { ok: false, reason: "not_found", auditId };
          }
          currentRev = currentRev.rows[0];

          // Check document filter
          if (!matchesFilters(currentRev, grant.documentFilter)) {
            const auditId = await writeAudit(app, {
              userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
              intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "not_found", via: ctx.via });
            return { ok: false, reason: "not_found", auditId };
          }

          // Conflict check: if any field in proposal._rev_fields was changed after _rev_base,
          // refuse with conflict. Scan revisions with _rev_seq > _rev_base and _rev_status = 'approved'.
          if (proposal._rev_base !== null && proposedFields.length > 0) {
            const conflictQ = await client.query(
              `select _rev_fields from ${table}
               where ${ident(pk)} = $1 and _rev_status = 'approved' and _rev_seq > $2
               order by _rev_seq asc`,
              [proposal[pk], proposal._rev_base]);

            const changedSince = new Set<string>();
            for (const row of conflictQ.rows) {
              const fields = row._rev_fields || [];
              for (const f of fields) changedSince.add(f);
            }

            // Check for overlap
            const overlap = proposedFields.some(f => changedSince.has(f));
            if (overlap) {
              const auditId = await writeAudit(app, {
                userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
                intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "conflict", via: ctx.via });
              return { ok: false, reason: "conflict", auditId };
            }
          }
        }

        // Promotion: merge the proposal with the current state
        const dataCols = Object.entries(c.fields).filter(([, f]) => !f.view_join).map(([n]) => n);

        // Build the merged row: start with current, overwrite with proposal's changes
        const merged: Record<string, unknown> = {};
        if (currentRev) {
          for (const f of dataCols) merged[f] = currentRev[f];
        } else {
          // Create case: use proposal values
          for (const f of dataCols) merged[f] = proposal[f];
        }
        // Overwrite with proposed changes
        for (const f of proposedFields) {
          if (dataCols.includes(f)) {
            merged[f] = proposal[f];
          }
        }

        // Determine the new _rev_seq: max(_rev_seq for that document) + 1
        let newSeq: number;
        if (proposal._rev_op === "create") {
          newSeq = 1;
        } else {
          // For update/delete, find max _rev_seq and add 1
          const maxSeqQ = await client.query(
            `select max(_rev_seq) as max_seq from ${table} where ${ident(pk)} = $1`,
            [proposal[pk]]);
          const maxSeq = maxSeqQ.rows[0]?.max_seq ? Number(maxSeqQ.rows[0].max_seq) : 0;
          newSeq = maxSeq + 1;
        }

        // Write the new current revision
        const newRevId = randomUUID();
        const REV_COLS = ["_rev", "_rev_seq", "_rev_at", "_rev_by", "_rev_op", "_rev_status",
          "_rev_fields", "_rev_base", "_current", "org_id"];
        const cols = [...REV_COLS, ...dataCols].map(ident).join(", ");
        const vals: unknown[] = [newRevId, newSeq, new Date(), proposal._rev_by, proposal._rev_op,
          "approved", proposal._rev_fields, proposal._rev_base, true, ctx.orgId,
          ...dataCols.map((k) => merged[k] ?? null)];

        // If there's a current revision, demote it BEFORE promoting the new one
        if (currentRev) {
          await client.query(`update ${table} set _current = false where _rev = $1`, [currentRev._rev]);
        }

        // Insert the new merged revision
        await client.query(
          `insert into ${table} (${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`, vals);

        // Mark the proposal as approved
        await client.query(`update ${table} set _rev_status = 'approved' where _rev = $1`, [proposalId]);

        // Get the document ID for the response
        const docId = String(merged[pk] ?? proposal[pk]);

        await writeChangeLog(client, ctx, collectionName, docId, newRevId, proposal._rev_op, "approved");

        const auditId = await writeAudit(app, {
          userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
          intent: null, fieldsReturned: [], grantId: grant.id, outcome: "allowed", reason: null, via: ctx.via });

        return { ok: true as const, documentId: docId, rev: newRevId, auditId };
      });
    } catch (err) {
      console.error("[broker] approveProposal failed", { proposalId, err });
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "internal_error", via: ctx.via });
      return { ok: false, reason: "internal_error", auditId };
    }
  }

  async function rejectProposal(ctx: BrokerContext, proposalId: string): Promise<{ ok: true; auditId: string } | { ok: false; reason: MutationRefusalReason; auditId: string }> {
    const schema = ctx.env === "live" ? "data_live" : "data_synth";

    const pool = writePool(pools, ctx);
    if (!pool) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "not_writable", via: ctx.via });
      return { ok: false, reason: "not_writable", auditId };
    }

    try {
      return await withOrg(pool, ctx.orgId, async (client) => {
        const collections = revisableCollections(cfg);
        let proposal: any = null;
        let collectionName: string | null = null;

        for (const coll of collections) {
          const table = `${schema}.${ident(coll)}`;
          const q = await client.query(`select * from ${table} where _rev = $1 and _rev_status = 'pending'`, [proposalId]);
          if (q.rowCount && q.rowCount > 0) {
            proposal = q.rows[0];
            collectionName = coll;
            break;
          }
        }

        if (!proposal || !collectionName) {
          const auditId = await writeAudit(app, {
            userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId,
            intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "not_found", via: ctx.via });
          return { ok: false, reason: "not_found", auditId };
        }

        const grant = await loadActiveGrant(app, ctx, collectionName);
        if (!grant || !grant.verbs.includes("approve")) {
          const auditId = await writeAudit(app, {
            userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
            intent: null, fieldsReturned: [], grantId: grant?.id ?? null, outcome: "refused", reason: "verb_denied", via: ctx.via });
          return { ok: false, reason: "verb_denied", auditId };
        }

        const table = `${schema}.${ident(collectionName)}`;
        await client.query(`update ${table} set _rev_status = 'rejected' where _rev = $1`, [proposalId]);

        const c = findCollection(cfg, collectionName);
        const pk = c ? Object.entries(c.fields).find(([, f]) => f.pk)?.[0] : null;
        const docId = pk ? String(proposal[pk]) : String(proposal.id ?? proposal.document_id);
        await writeChangeLog(client, ctx, collectionName, docId, proposalId, proposal._rev_op, "rejected");

        const auditId = await writeAudit(app, {
          userId: ctx.userId, env: ctx.env, collection: collectionName, orgId: ctx.orgId,
          intent: null, fieldsReturned: [], grantId: grant.id, outcome: "allowed", reason: null, via: ctx.via });

        return { ok: true as const, auditId };
      });
    } catch (err) {
      console.error("[broker] rejectProposal failed", { proposalId, err });
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "internal_error", via: ctx.via });
      return { ok: false, reason: "internal_error", auditId };
    }
  }

  type ProposalSummary = {
    proposalId: string; collection: string; op: string; fields: string[];
    proposedBy: string; proposedAt: string; documentId: string;
  };

  // What a reviewer may see BEFORE deciding: metadata and the names of the fields a proposal
  // touches — never their values. A reviewer fetches content with getDocument, where postures
  // are already enforced; duplicating values into this listing would be a posture bypass.
  //
  // It reads the revision tables through the WRITE pool, because that is the only role with
  // SELECT on base tables — the read roles see views, and a view shows only current,
  // non-tombstoned revisions, which is exactly the set a pending proposal is not in.
  async function listProposals(
    ctx: BrokerContext, opts: { collection?: string; status?: "pending" | "approved" | "rejected" } = {},
  ): Promise<
    { ok: true; proposals: ProposalSummary[]; auditId: string }
    | { ok: false; reason: RefusalReason; auditId: string }
  > {
    const auditList = (outcome: "allowed" | "refused", reason: RefusalReason | null) =>
      writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection ?? "*", orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome, reason, via: ctx.via });

    const pool = writePool(pools, ctx);
    if (!pool) return { ok: false, reason: "internal_error", auditId: await auditList("refused", "internal_error") };

    const schema = ctx.env === "live" ? "data_live" : "data_synth";
    const status = opts.status ?? "pending";
    const names = opts.collection ? [opts.collection] : Object.keys(cfg.collections);

    try {
      const proposals = await withOrg(pool, ctx.orgId, async (client) => {
        const out: ProposalSummary[] = [];
        for (const name of names) {
          const c = findCollection(cfg, name);
          // Only revisable collections have proposals at all.
          if (!c || !c.writable || c.type === "file") continue;

          // Fresh per collection, like every other grant check. No approve verb → this
          // collection is simply absent from the feed, not a refusal: a reviewer learning
          // which collections they cannot approve for is itself a disclosure.
          const grant = await loadActiveGrant(app, ctx, name);
          if (!grant || !grant.verbs.includes("approve")) continue;

          // Bookkeeping columns only, plus the document-filter field when one is set. Selecting
          // `*` would pull ungranted values into memory even if they were never returned, and
          // "denied means absent" means never fetched, not filtered afterwards.
          const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
          const cols = ["_rev", "_rev_op", "_rev_fields", "_rev_by", "_rev_at"];
          if (pk) cols.push(pk);
          for (const f of grant.documentFilter)
            if (Object.hasOwn(c.fields, f.field) && !cols.includes(f.field)) cols.push(f.field);

          const q = await client.query(
            `select ${cols.map(ident).join(", ")} from ${schema}.${ident(name)}
             where _rev_status = $1 order by _rev_at`, [status]);

          for (const row of q.rows) {
            if (!matchesFilters(row, grant.documentFilter)) continue;
            out.push({
              proposalId: row._rev,
              collection: name,
              op: row._rev_op,
              fields: row._rev_fields ?? [],
              proposedBy: row._rev_by,
              proposedAt: row._rev_at,
              documentId: String(pk ? row[pk] : ""),
            });
          }
        }
        return out;
      });

      return { ok: true as const, proposals, auditId: await auditList("allowed", null) };
    } catch (err) {
      console.error("[broker] listProposals failed", { err });
      return { ok: false, reason: "internal_error", auditId: await auditList("refused", "internal_error") };
    }
  }

  async function changes(
    ctx: BrokerContext,
    opts: { since?: number; limit?: number } = {},
  ): Promise<
    | { ok: true; entries: Array<{ seq: number; collection: string; documentId: string; rev: string; op: string; status: string; at: string; by: string }>; auditId: string }
    | { ok: false; reason: RefusalReason; auditId: string }
  > {
    const since = opts.since ?? 0;
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    try {
      // Load all grants to filter collections; caller sees only collections they can read
      const collections = Object.keys(cfg.collections);
      const grantsByCollection = new Map<string, ActiveGrant | null>();
      for (const c of collections) {
        const grant = await loadActiveGrant(app, ctx, c);
        // No grant or no read verb → no entries for this collection
        if (grant && grant.verbs.includes("read")) grantsByCollection.set(c, grant);
      }

      // `seq` order is not commit order. bigserial hands out numbers when a statement runs,
      // not when its transaction commits, so a writer can take seq 7 and commit *after* a
      // writer holding seq 8. A reader that polls in between would see 8, advance its cursor
      // past 7, and lose that entry forever — a silently lossy feed.
      //
      // So hold back anything an in-flight transaction could still be sitting on: only return
      // rows whose inserting transaction is older than the oldest one currently running.
      // `xmin` is the row's inserting xid; pg_snapshot_xmin is the watermark below which every
      // transaction has finished. Once a row passes this test, no lower `seq` can appear later.
      // The alternative — a fixed time delay — is both laggy and still wrong for any
      // transaction that outlives the delay.
      const entries = await withOrg(dataPool(pools, ctx), ctx.orgId, async (client: PoolClient) => {
        const q = await client.query(
          `select seq, collection, document_id, rev, op, status, at, by
           from app.change_log
           where org_id = $1 and env = $2 and seq > $3
             and xmin::text::bigint < pg_snapshot_xmin(pg_current_snapshot())::text::bigint
           order by seq asc limit $4`,
          [ctx.orgId, ctx.env, since, limit],
        );
        return q.rows;
      });

      // Grant-filtered by collection only. A grant's document_filter is NOT applied: the feed
      // carries no field data, so there is nothing here to test a field predicate against. The
      // consequence is deliberate and bounded — a caller with a document-filtered grant learns
      // that *some* document in that collection changed, and its id, but not which fields moved
      // or what they now hold. getDocument then refuses the ones outside the filter. Stated in
      // docs/architecture.md rather than left to be discovered.
      const filtered = entries.filter((e) => grantsByCollection.has(e.collection));

      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId, intent: null,
        fieldsReturned: [], grantId: null, outcome: "allowed", reason: null, via: ctx.via,
      });

      return {
        ok: true as const,
        entries: filtered.map((e) => ({
          seq: Number(e.seq),
          collection: e.collection,
          documentId: e.document_id,
          rev: String(e.rev),
          op: e.op,
          status: e.status,
          at: new Date(e.at).toISOString(),
          by: e.by,
        })),
        auditId,
      };
    } catch (err) {
      console.error("[broker] changes failed", { err });
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId, intent: null,
        fieldsReturned: [], grantId: null, outcome: "refused", reason: "internal_error", via: ctx.via,
      });
      return { ok: false, reason: "internal_error", auditId };
    }
  }

  type RevisionMetadata = {
    rev: string; seq: number; at: string; by: string; op: string; status: string; fields: string[];
  };

  async function listRevisions(
    ctx: BrokerContext, opts: { collection: string; id: string },
  ): Promise<
    { ok: true; revisions: RevisionMetadata[]; auditId: string }
    | { ok: false; reason: RefusalReason; auditId: string }
  > {
    const c = findCollection(cfg, opts.collection);
    if (!c) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "unknown_collection", via: ctx.via });
      return { ok: false, reason: "unknown_collection", auditId };
    }
    if (!c.writable) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "invalid_intent", via: ctx.via });
      return { ok: false, reason: "invalid_intent", auditId };
    }

    const pool = writePool(pools, ctx);
    if (!pool) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "internal_error", via: ctx.via });
      return { ok: false, reason: "internal_error", auditId };
    }

    const grant = await loadActiveGrant(app, ctx, opts.collection);
    if (!grant) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "no_grant", via: ctx.via });
      return { ok: false, reason: "no_grant", auditId };
    }
    if (!grant.verbs.includes("read")) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: null, outcome: "refused", reason: "no_grant", via: ctx.via });
      return { ok: false, reason: "no_grant", auditId };
    }

    const all = Object.keys(c.fields);
    for (const f of grant.documentFilter) {
      if (all.includes(f.field)) continue;
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "invalid_intent", via: ctx.via });
      return { ok: false, reason: "invalid_intent", auditId };
    }

    const schema = ctx.env === "live" ? "data_live" : "data_synth";
    const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
    if (!pk) {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "invalid_intent", via: ctx.via });
      return { ok: false, reason: "invalid_intent", auditId };
    }

    const cols = ["_rev", "_rev_seq", "_rev_at", "_rev_by", "_rev_op", "_rev_status", "_rev_fields"];
    for (const f of grant.documentFilter)
      if (Object.hasOwn(c.fields, f.field) && !cols.includes(f.field)) cols.push(f.field);

    try {
      const revisions = await withOrg(pool, ctx.orgId, async (client) => {
        // Fetch current row to apply document filter against
        const currentQ = await client.query(
          `select ${cols.map(ident).join(", ")} from ${schema}.${ident(opts.collection)}
           where org_id=$1 and ${ident(pk)}=$2 and _current`, [ctx.orgId, opts.id]);

        if (currentQ.rows.length === 0) {
          return null; // Document not found or filtered out
        }
        const currentRow = currentQ.rows[0];
        if (!matchesFilters(currentRow, grant.documentFilter)) {
          return null; // Document filtered out
        }

        // Fetch all revisions for this document, ordered by seq
        const q = await client.query(
          `select ${cols.map(ident).join(", ")} from ${schema}.${ident(opts.collection)}
           where org_id=$1 and ${ident(pk)}=$2 order by _rev_seq asc`, [ctx.orgId, opts.id]);

        return q.rows.map((row) => ({
          rev: String(row._rev),
          seq: Number(row._rev_seq),
          at: new Date(row._rev_at).toISOString(),
          by: String(row._rev_by),
          op: String(row._rev_op),
          status: String(row._rev_status),
          fields: row._rev_fields ?? [],
        }));
      });

      if (!revisions) {
        const auditId = await writeAudit(app, {
          userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
          intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "not_found", via: ctx.via });
        return { ok: false, reason: "not_found", auditId };
      }

      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: grant.id, outcome: "allowed", reason: null, via: ctx.via });
      return { ok: true, revisions, auditId };
    } catch (err) {
      console.error("[broker] listRevisions failed", { collection: opts.collection, id: opts.id, err });
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: opts.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "internal_error", via: ctx.via });
      return { ok: false, reason: "internal_error", auditId };
    }
  }

  // The proposed values of a pending revision, reduced to the fields the reviewer may read.
  //
  // listProposals deliberately returns changed field NAMES and no values, and getDocument
  // cannot help for a `create`: the document is not in any view until it is approved, so a
  // reviewer would be asked to approve content they cannot see. This reads the pending
  // revision itself, through the same grant and posture gates as any other read — a reviewer
  // sees a proposed value only where their own grant would have let them read that field.
  async function getProposal(
    ctx: BrokerContext, proposalId: string,
  ): Promise<
    { ok: true; collection: string; op: string; documentId: string; proposedBy: string;
      proposedAt: string; fields: string[]; values: Document; fieldsReturned: string[]; auditId: string }
    | { ok: false; reason: RefusalReason; auditId: string }
  > {
    const refuse = async (reason: RefusalReason, collection: string, grantId: string | null) => {
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: [], grantId, outcome: "refused", reason, via: ctx.via });
      return { ok: false as const, reason, auditId };
    };

    const pool = writePool(pools, ctx);
    if (!pool) return refuse("internal_error", "*", null);

    const schema = ctx.env === "live" ? "data_live" : "data_synth";

    try {
      const found = await withOrg(pool, ctx.orgId, async (client) => {
        for (const coll of revisableCollections(cfg)) {
          const q = await client.query(
            `select * from ${schema}.${ident(coll)} where _rev = $1 and _rev_status = 'pending'`,
            [proposalId]);
          if (q.rowCount && q.rowCount > 0) return { coll, row: q.rows[0] };
        }
        return null;
      });

      if (!found) return refuse("not_found", "*", null);

      const c = findCollection(cfg, found.coll);
      if (!c) return refuse("unknown_collection", found.coll, null);

      const grant = await loadActiveGrant(app, ctx, found.coll);
      // Approving is the act this read exists to inform, so it is gated on `approve`, not
      // merely `read` — matching approveProposal's own requirement.
      if (!grant || !grant.verbs.includes("read") || !grant.verbs.includes("approve"))
        return refuse("no_grant", found.coll, grant?.id ?? null);

      if (!matchesFilters(found.row, grant.documentFilter))
        return refuse("not_found", found.coll, grant.id);

      const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
      if (!pk) return refuse("invalid_intent", found.coll, grant.id);

      // Same rule as every other read: a field is visible only if the grant carries it.
      const readable = grant.allowedFields.filter((f) => Object.hasOwn(c.fields, f));
      const values: Document = {};
      for (const f of readable) values[f] = found.row[f];

      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: found.coll, orgId: ctx.orgId,
        intent: null, fieldsReturned: readable, grantId: grant.id, outcome: "allowed", reason: null, via: ctx.via });

      return {
        ok: true,
        collection: found.coll,
        op: String(found.row._rev_op),
        documentId: String(found.row[pk]),
        proposedBy: String(found.row._rev_by),
        proposedAt: new Date(found.row._rev_at).toISOString(),
        fields: found.row._rev_fields ?? [],
        values,
        fieldsReturned: readable,
        auditId,
      };
    } catch (err) {
      console.error("[broker] getProposal failed", { proposalId, err });
      return refuse("internal_error", "*", null);
    }
  }

  return { query, describeCollection, listCollections, searchDocuments, getDocument, mutate, approveProposal, rejectProposal, listProposals, changes, listRevisions, getProposal };
}

// Collections that carry revision columns. A proposal only ever lives in one of these, and
// the _rev/_rev_status columns exist nowhere else — see tableDDL, which emits them only for
// writable non-file datasets. Approve/reject scan for a proposal by id across collections,
// so they must scan this set rather than every configured collection.
function revisableCollections(cfg: WarehousdConfig): string[] {
  return Object.entries(cfg.collections)
    .filter(([, c]) => c.writable && c.type !== "file")
    .map(([name]) => name);
}

// Identifier quoting for the write path. Column and collection names come from the loaded
// config, which validates them at parse time, but the write path builds its own statements
// rather than going through buildSelect — so it re-asserts the same rule rather than trusting
// that. A bad identifier here means a broker bug, and throwing surfaces it as internal_error.
const WRITE_IDENT = /^[a-z_][a-z0-9_]*$/i;
function ident(id: string): string {
  if (!WRITE_IDENT.test(id)) throw new Error(`unsafe identifier: ${id}`);
  return `"${id}"`;
}

// Write a change log entry in the same transaction as the revision. Must be called inside
// withOrg on the write pool. This binds the feed to revisions: if the tx rolls back,
// so does the feed entry, keeping them consistent.
async function writeChangeLog(
  client: PoolClient,
  ctx: BrokerContext,
  collection: string,
  documentId: string,
  rev: string,
  op: string,
  status: string,
): Promise<void> {
  await client.query(
    `insert into app.change_log (org_id, env, collection, document_id, rev, op, status, by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.orgId, ctx.env, collection, documentId, rev, op, status, ctx.userId],
  );
}

// The grant's document filters, ANDed, evaluated against a row the write path already holds.
// Reading the row and testing in JS avoids a second round trip; `$self` is bound by
// loadActiveGrant, so by here every value is a plain literal. An empty list scopes nothing,
// which is the same thing buildSelect does with it.
function matchesFilters(row: Record<string, unknown>, filters: DocumentFilter[]): boolean {
  return filters.every((f) => matchesFilter(row, f));
}

function matchesFilter(row: Record<string, unknown>, f: DocumentFilter): boolean {
  const actual = row[f.field];
  const wanted = f.op === "in" && Array.isArray(f.value) ? f.value : [f.value];
  // A field bound to a `multiple: true` vocabulary is a text[] column, which buildSelect
  // matches with `&&`/`= any`. Test for overlap here too, or the in-process path and the SQL
  // path disagree about the same grant.
  const held = Array.isArray(actual) ? actual : [actual];
  return wanted.some((v: unknown) => held.some((a: unknown) => String(v) === String(a)));
}

// Every field named anywhere in the intent (fields, filters, orderBy, aggregate, groupBy).
function collectReferenced(intent: QueryIntent): string[] {
  const s = new Set<string>();
  (intent.fields ?? []).forEach((f) => s.add(f));
  (intent.filters ?? []).forEach((f) => s.add(f.field));
  if (intent.orderBy) s.add(intent.orderBy.field);
  (intent.aggregate ?? []).forEach((a) => s.add(a.field));
  (intent.groupBy ?? []).forEach((f) => s.add(f));
  return [...s];
}
