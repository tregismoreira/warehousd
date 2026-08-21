import type { PoolClient } from "pg";
import type {
  BrokerContext,
  QueryIntent,
  DocSearchIntent,
  SearchedCollection,
  BrokerResult,
  VisibleSchema,
  Refusal,
  GetDocumentIntent,
  GetDocumentResult,
  Document,
  Filter,
  BatchQueryResult,
} from "../types";
import { MAX_LIMIT, DEFAULT_LIMIT, MAX_BATCH_QUERIES } from "../types";
import type { CollectionListing } from "../types";
import { buildSelect, UnsupportedFilter } from "../sql/build";
import { ident } from "../sql/ident";
import { decodeCursor, encodeCursor, type Cursor } from "../sql/cursor";
import { dataPool, withWorkspace, writePool } from "../db/pools";
import { findCollection } from "../config/load";
import { kindOf } from "../config/kinds";
import type { CollectionConfig } from "../config/schema";
import { pkOf, dataSchema } from "../config/collection";
import { reassembleChunks } from "../indexing/chunk";
import { makeAuditWriter } from "../audit/decision";
import {
  QueryIntentSchema,
  DocSearchIntentSchema,
  GetDocumentIntentSchema,
  BatchQueryIntentSchema,
  checkIntent,
} from "../intents/schema";
import { resolveGranted } from "./guard";
import { loadActiveGrants } from "../grants/eval";
import type { VerbDeps } from "./deps";

export function makeReadVerbs(d: VerbDeps) {
  const { app, cfg, pools, isMultiValueField } = d;

  async function query(ctx: BrokerContext, raw: QueryIntent): Promise<BrokerResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    // 0. intent shape at runtime, before anything reads it
    const parsed = checkIntent(QueryIntentSchema, raw, "query");
    if (!parsed.ok) return audit.refuse(parsed.collection, "invalid_intent");
    const intent = parsed.intent;
    // 1. intent shape
    if (intent.aggregate && intent.aggregate.length && intent.fields && intent.fields.length)
      return audit.refuse(intent.collection, "invalid_intent", { intent });
    // 2. every referenced field must exist on the collection at all. Answerable without a grant,
    // and asked before one is loaded so a typo cannot be mistaken for a denial.
    const c0 = findCollection(cfg, intent.collection);
    if (!c0) return audit.refuse(intent.collection, "unknown_collection", { intent });
    const all = Object.keys(c0.fields);
    const referenced = collectReferenced(intent);
    for (const f of referenced)
      if (!all.includes(f)) return audit.refuse(intent.collection, "unknown_field", { intent });
    // 2b. Keyset pagination — resolved before the grant so its errors read the same as any other
    // malformed intent, and so the sort field and pk can be folded into the grant's field check
    // below rather than checked a second way. See sql/cursor.ts for what a cursor does and does
    // not protect, and docs/rest-api.md for the caller-facing contract.
    //
    // `after` and `offset` are two answers to "where do I resume", and a caller supplying both is
    // asking a question with no defined winner. Same reasoning for `after` and `aggregate`: an
    // aggregate collapses many documents into one row, and there is nothing left to walk.
    if (intent.after !== undefined && intent.offset !== undefined)
      return audit.refuse(intent.collection, "invalid_intent", { intent });
    if (intent.after !== undefined && intent.aggregate && intent.aggregate.length)
      return audit.refuse(intent.collection, "invalid_intent", { intent });
    const pk = pkOf(c0);
    // A collection with no declared pk (a file collection, whose identity is `path`) has no total
    // order to page over, so keyset never applies to it. That is silent when the caller did not
    // ask to use it — an ordinary query against such a collection is exactly what it always was —
    // and refused when they explicitly did, by handing back a cursor.
    if (intent.after !== undefined && pk === null)
      return audit.refuse(intent.collection, "invalid_intent", { intent });
    const keysetActive =
      pk !== null && !(intent.aggregate && intent.aggregate.length) && intent.offset === undefined;
    const sortField = keysetActive ? (intent.orderBy?.field ?? pk) : null;
    const dir = intent.orderBy?.dir ?? "asc";
    // A NULL inside the row-value comparison keyset builds makes the predicate UNKNOWN rather
    // than false, which drops documents from the walk silently — worse than refusing outright.
    if (sortField && c0.fields[sortField]?.nullable === true)
      return audit.refuse(intent.collection, "invalid_intent", { intent });
    // An EXPLICIT orderBy names a field the caller chose to sort by, so it is theirs to be
    // entitled to, exactly as it was before keyset existed. The DEFAULTED sortField is `pk`, which
    // the caller never asked for — folding that into the required list would make a grant that
    // omits the primary key unable to read the collection at all, which is what trimming a grant
    // to the minimum necessary fields routinely produces. The keyset gate below handles it
    // instead, by withholding the cursor rather than the documents.
    if (intent.orderBy?.field && !referenced.includes(intent.orderBy.field))
      referenced.push(intent.orderBy.field);
    // Presenting a cursor is the one request that genuinely cannot be answered without the pk: it
    // was minted from one and resumes on one, so the pk is part of what the caller is asking for.
    if (intent.after !== undefined && pk && !referenced.includes(pk)) referenced.push(pk);
    // 3. grant, read verb, field coverage, document filters, mask plan, ACL options — all of it,
    // in one place, already audited on any refusal. See verbs/guard.ts.
    const g = await resolveGranted(d, audit, ctx, intent.collection, "read", {
      detail: { intent },
      fields: referenced,
    });
    if (!g.ok) return g;
    const { grant, plan } = g;
    // 4. a masked field may be PROJECTED but never computed over — see collectComputed. `pk` is
    // folded in only when keyset is active: it lands in a row-value comparison exactly like
    // orderBy's field does, and the reasoning is the same one collectComputed already states.
    //
    // The cursor carries `pk`'s value back to the caller in `nextCursor`, so a caller who cannot
    // read the pk must not be handed one. That is a reason to withhold the CURSOR, not the
    // documents: keyset simply does not engage, and an ordinary first page comes back exactly as
    // it did before keyset existed. Asking to RESUME a cursor without the pk is still a refusal,
    // because that request cannot be answered at all.
    const keyset = keysetActive && pk !== null && grant.allowedFields.includes(pk);
    if (intent.after !== undefined && !keyset)
      return audit.refuse(intent.collection, "field_denied", { intent, grant });
    const computed = collectComputed(intent);
    if (keyset && pk) computed.push(pk);
    for (const f of computed)
      if (plan.masked.has(f))
        return audit.refuse(intent.collection, "field_denied", { intent, grant });
    // A cursor from one ordering must not walk another: it would silently resume a DIFFERENT sort
    // than the one it was minted under, which is not "the next page" of anything.
    let cursor: Cursor | null = null;
    if (intent.after !== undefined) {
      const cur = decodeCursor(intent.after);
      if (!cur || cur.f !== sortField || cur.d !== dir)
        return audit.refuse(intent.collection, "invalid_intent", { intent, grant });
      cursor = cur;
    }
    // fields to select: explicit, else all granted fields present on the collection. This is the
    // CLIENT-VISIBLE list — what `fieldsReturned` and every document key will be — and is
    // deliberately untouched by keyset: a caller who named an explicit narrow projection gets
    // exactly that projection back, exactly as before keyset existed.
    const selectFields =
      intent.fields && intent.fields.length
        ? intent.fields
        : grant.allowedFields.filter((f) => all.includes(f));
    // `sortField` and `pk` still have to come back from Postgres to build the next cursor even
    // when the caller did not ask for them — so they are added to the actual SQL SELECT here, and
    // stripped back off each row below before anything is handed to the caller or named in
    // `fieldsReturned`. A cursor is an opaque token; nothing about using one requires the caller to
    // have projected the columns it is built from.
    const cursorExtra =
      keyset && sortField && pk ? [sortField, pk].filter((f) => !selectFields.includes(f)) : [];
    const querySelectFields = cursorExtra.length ? [...selectFields, ...cursorExtra] : selectFields;
    const effectiveLimit = Math.min(Math.max(1, intent.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    // 5. build + execute on the env-scoped pool through withWorkspace transaction
    try {
      const { text, values } = buildSelect(
        ctx.env,
        { ...intent, fields: querySelectFields },
        grant.allowedFields,
        {
          documentFilters: grant.documentFilter,
          isMultiValueField,
          maskFor: plan.maskFor,
          // Only for a collection whose view carries an `_acl` column. Passed here — where the
          // aggregate branch is built too — so the predicate lands in the same WHERE every
          // aggregate reads: a count over an ACL'd collection counts what this caller may see, not
          // what exists and then a shortfall that reports the difference.
          ...g.aclOpts,
          ...(keyset && sortField && pk
            ? {
                keyset: {
                  field: sortField,
                  dir,
                  pk,
                  ...(cursor ? { after: cursor.k } : {}),
                },
              }
            : {}),
        },
      );
      const rawDocuments = await withWorkspace(
        dataPool(pools, ctx),
        ctx.workspaceId,
        async (client: PoolClient) => {
          return (await client.query(text, values)).rows;
        },
      );
      // A short page (fewer documents than the clamped limit) is how the caller learns the walk
      // ended. Only built when keyset actually ran — an aggregate or offset query has no cursor to
      // hand back, and forcing one would claim a capability the request never had.
      const last = rawDocuments[rawDocuments.length - 1];
      const nextCursor =
        keyset && sortField && pk && rawDocuments.length === effectiveLimit && last
          ? encodeCursor({ v: 1, f: sortField, d: dir, k: [last[sortField], last[pk]] })
          : undefined;
      // Strip the cursor-only columns back off before anything leaves this function — the caller
      // never asked for them, so `documents` and `fieldsReturned` stay exactly what they would
      // have been without keyset.
      const documents = cursorExtra.length
        ? rawDocuments.map((row) => {
            const copy = { ...row };
            for (const f of cursorExtra) delete copy[f];
            return copy;
          })
        : rawDocuments;
      const fieldsReturned =
        intent.aggregate && intent.aggregate.length
          ? [...(intent.groupBy ?? []), ...intent.aggregate.map((a) => `${a.fn}_${a.field}`)]
          : selectFields;
      const rec = await audit.allow(intent.collection, {
        intent,
        fieldsReturned,
        // Which of those came back raw. The compliance question a masked field creates is not
        // "who read it" but "who read it unmasked", and this is the only record that answers it.
        unmaskedFields: selectFields.filter((f) => grant.unmaskedFields.includes(f)),
        grant,
      });
      if (!rec.ok) return rec;
      return {
        ok: true,
        documents,
        fieldsReturned,
        auditId: rec.auditId,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    } catch (err) {
      // A filter the builder can't express is the caller's mistake, not ours. It carries no
      // driver detail, so answering invalid_intent tells them something actionable.
      if (err instanceof UnsupportedFilter)
        return audit.refuse(intent.collection, "invalid_intent", { intent, grant });
      // Never surface a raw driver error: Postgres messages name columns, tables and
      // values, which is exactly what §10 test 4 forbids leaking. The audit row is
      // the non-negotiable part — an unaudited probe leaves no trace.
      console.error("[broker] query failed", { collection: intent.collection, err });
      return audit.refuse(intent.collection, "internal_error", { intent, grant });
    }
  }

  /**
   * A labelled batch of up to MAX_BATCH_QUERIES read-only queries, run one after another and
   * returned in one envelope keyed by the caller's own labels.
   *
   * Three rules, one borrowed from searchAll twice and one that makes this the deliberate
   * opposite of decideProposals:
   *
   *   - **Sequential, not parallel — no `Promise.all`.** Same reasoning as searchAll's own `for`
   *     loop above: each sub-query opens its own transaction on a pool sized for one request, and
   *     ten at once is how a page-open takes the whole app down.
   *   - **One audit row per sub-query, plus one for the envelope**, matching searchAll's own
   *     envelope row — the trail records that a single request reached N collections rather than
   *     leaving N rows to be correlated by timestamp.
   *   - **Partial failure is the contract, not a bug.** A refusing sub-query returns its own
   *     `{ ok: false, reason, auditId }` in its slot, and the others still return documents; the
   *     envelope is `ok: true` regardless. This is the deliberate OPPOSITE of decideProposals'
   *     all-or-nothing batch: a read has nothing to roll back, and refusing the whole page because
   *     one of ten collections denied it would throw away nine good answers for one bad one. Read
   *     batching and write batching must never converge on one failure model.
   *
   * The isolation property that matters: every sub-query runs through `query()` completely
   * unchanged, which is what makes isolation automatic rather than something this function has to
   * get right by hand. Each call loads its OWN grant (`loadActiveGrant`), runs its OWN
   * `resolveGranted`, builds its OWN mask plan and its OWN ACL predicate — nothing is hoisted out
   * of the loop and shared across sub-queries. That is the whole of the isolation property, and
   * the whole reason this stays a plain sequential loop calling `query()` rather than a batched
   * variant of the SQL it builds: hoisting so much as the grant load would let one sub-query's
   * posture leak into another's.
   */
  async function queryBatch(ctx: BrokerContext, raw: unknown): Promise<BatchQueryResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const parsed = checkIntent(BatchQueryIntentSchema, raw, "queryBatch");
    if (!parsed.ok) return audit.refuse("*", "invalid_intent");
    const { queries } = parsed.intent;

    if (queries.length > MAX_BATCH_QUERIES) return audit.refuse("*", "invalid_intent");

    // Duplicate labels are refused before any sub-query runs: a partially-executed batch that
    // then refuses the envelope would audit reads the caller never got a result for.
    const seen = new Set<string>();
    for (const q of queries) {
      if (seen.has(q.label)) return audit.refuse("*", "invalid_intent");
      seen.add(q.label);
    }

    const results: Record<string, BrokerResult> = {};
    for (const q of queries) {
      // Stripped explicitly, rather than relying on query()'s own re-parse to drop it: the intent
      // query() audits (and the intent it builds SQL from) must be exactly a QueryIntent, with no
      // batch-only key riding along by accident.
      const { label, ...intent } = q;
      results[label] = await query(ctx, intent);
    }

    const rec = await audit.allow("*", {
      intent: { op: "queryBatch", labels: queries.map((q) => q.label) },
    });
    if (!rec.ok) return rec;
    return { ok: true, results, auditId: rec.auditId };
  }

  async function describeCollection(
    ctx: BrokerContext,
    name: string,
  ): Promise<VisibleSchema | Refusal> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    // No document filters to check here — describe returns a schema, not documents — but running
    // the same guard is what keeps "which collections can this caller describe" and "which can it
    // read" one answer rather than two that drift.
    const g = await resolveGranted(d, audit, ctx, name, "read", { checkFilters: false });
    if (!g.ok) return g;
    const { collection: c, grant, plan } = g;
    const fields = Object.entries(c.fields)
      .filter(([n]) => grant.allowedFields.includes(n))
      // type is guaranteed by CollectionSchema refinement for structured collections; file collections have types filled in by transform
      // A multi-value term field is pinned to `text` in config so the schema stays simple, but
      // the column is text[]. Report what the caller will actually be querying, or they write a
      // scalar filter against an array and get a refusal they can't diagnose.
      //
      // `masked` is reported for the same reason: a caller that does not know a field is
      // transformed will filter on it, get field_denied, and have no way to tell that from a
      // field it was never granted. Saying so here is not a disclosure — it describes the shape
      // of what this caller already holds, not what anyone else can see.
      .map(([n, f]) => ({
        name: n,
        type: isMultiValueField(n) ? "text[]" : f.type!,
        pk: f.pk,
        ...(plan.masked.has(n) ? { masked: true as const } : {}),
      }));
    const rec = await audit.allow(name, {
      fieldsReturned: fields.map((f) => f.name),
      grant,
    });
    if (!rec.ok) return rec;
    return { collection: name, description: c.description, fields };
  }

  /**
   * The catalogue, annotated with the caller's OWN access.
   *
   * Without `access`, a model facing twenty collections burns twenty `describe_collection` calls
   * to find its three — and the refusals it gets back are indistinguishable from a
   * misconfiguration, so it cannot even learn from them. Saying which ones it holds a grant on is
   * not a disclosure: the caller learns only about grants it already has.
   *
   * `grantedFields` is a COUNT, not a list. The count is what a model needs to decide whether a
   * collection is worth describing; the names are what `describe_collection` is for, and putting
   * them here would make discovery a cheaper way to enumerate a grant than the verb that audits
   * it field by field.
   */
  async function listCollections(ctx: BrokerContext): Promise<CollectionListing[] | Refusal> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    // The client's collection ceiling applies to discovery too. loadActiveGrant enforces it on
    // every other verb, so without this a restricted client could enumerate names and
    // descriptions for collections no grant it holds can ever reach — a catalogue of what it is
    // not allowed to ask about. Names and descriptions *within* the ceiling stay visible to any
    // authenticated caller by design: that is what makes `request_access` usable.
    // `null`/absent means no ceiling, matching grants/eval.ts.
    const ceiling = ctx.allowedCollections;
    const visible = Object.entries(cfg.collections).filter(
      ([name]) => ceiling == null || ceiling.includes(name),
    );
    // The plural loader, which exists for exactly this batch shape: one round trip rather than
    // one per collection on the page a caller opens first.
    const grants = await loadActiveGrants(
      app,
      ctx,
      visible.map(([name]) => name),
    );
    const collections: CollectionListing[] = visible.map(([name, c]) => {
      const grant = grants.get(name);
      const readable = grant?.verbs.includes("read") ?? false;
      return {
        name,
        description: c.description,
        access: readable ? "granted" : "none",
        ...(readable
          ? {
              grantedFields: grant!.allowedFields.filter((f) => Object.hasOwn(c.fields, f)).length,
            }
          : {}),
      };
    });
    const rec = await audit.allow("*");
    if (!rec.ok) return rec;
    return collections;
  }

  /**
   * Search one collection, or every collection the caller holds a read grant on.
   *
   * The fan-out exists because a required `collection` made search unusable for the question
   * people actually ask: somebody asking "what's our parental leave policy" has to already know
   * it lives in `policies`. Absent means "everything I may read".
   *
   * Two rules the fan-out must not break:
   *
   *   - **Every per-collection decision is audited individually.** Twenty collections is twenty
   *     decisions, and collapsing them into one audit row would make "who searched what" a
   *     question the trail cannot answer. Refusals included — a collection that refused is part
   *     of what happened.
   *   - **Ranking is reciprocal-rank fusion, never raw scores.** `ts_rank` over different tsv
   *     columns and cosine distance over different embedding sets are not comparable numbers;
   *     averaging them produces a confidently wrong ordering. RRF needs only per-collection rank,
   *     which is the one thing that IS comparable.
   */
  async function searchDocuments(ctx: BrokerContext, raw: DocSearchIntent): Promise<BrokerResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const parsed = checkIntent(DocSearchIntentSchema, raw, "searchDocuments");
    if (!parsed.ok) return audit.refuse(parsed.collection, "invalid_intent");
    const intent = parsed.intent;
    if (typeof intent.q !== "string" || !intent.q.trim())
      return audit.refuse(intent.collection ?? "*", "invalid_intent", { intent });

    if (intent.collection !== undefined) {
      return searchOne(ctx, { ...intent, collection: intent.collection });
    }
    return searchAll(ctx, intent);
  }

  /** One collection. The path every caller took before the fan-out existed, unchanged. */
  async function searchOne(
    ctx: BrokerContext,
    intent: DocSearchIntent & { collection: string },
  ): Promise<BrokerResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const c0 = findCollection(cfg, intent.collection);
    if (!c0) return audit.refuse(intent.collection, "unknown_collection", { intent });

    // How this KIND matches: one generated tsv column over chunked content, or a per-field set of
    // `<name>_tsv` columns. Null means the collection cannot be searched at all.
    const search = kindOf(c0).searchable(c0);

    // Vector modes need three things, and each missing one is the caller's to fix rather than
    // something to paper over by quietly running a text search instead: a caller who asked for
    // `semantic` and silently got `text` cannot tell, and would draw conclusions from a ranking
    // that is not the one they requested.
    const mode = intent.mode ?? "text";
    if (mode !== "text") {
      // Only a chunked kind has an embedding column — a dataset document is a row, and there is
      // nothing chunked to embed.
      if (!kindOf(c0).chunked) return audit.refuse(intent.collection, "invalid_intent", { intent });
      if (!d.embedder) return audit.refuse(intent.collection, "invalid_intent", { intent });
    }
    if (!search) return audit.refuse(intent.collection, "invalid_intent", { intent });
    const searchableFields = search.fields;

    const all = Object.keys(c0.fields);
    for (const f of intent.fields ?? [])
      if (!all.includes(f)) return audit.refuse(intent.collection, "unknown_field", { intent });

    const g = await resolveGranted(d, audit, ctx, intent.collection, "read", {
      detail: { intent },
      fields: intent.fields ?? [],
    });
    if (!g.ok) return g;
    const { grant, plan } = g;
    const selectFields =
      intent.fields && intent.fields.length
        ? intent.fields
        : grant.allowedFields.filter((f) => all.includes(f));
    // A masked field is projected here like anywhere else. Search itself is unaffected: a
    // dataset's searchable fields cannot be masked (CollectionSchema refuses the combination,
    // because the generated <f>_tsv indexes the raw column), and a file collection matches on
    // `content`, which cannot be masked either.
    try {
      // The query vector is derived HERE, from the caller's `q`, after their grant has been
      // loaded and checked. There is no path by which a caller supplies one: that would be an
      // oracle over the embedding space of documents their grant excludes.
      const qVector = mode === "text" ? undefined : (await d.embedder!.embed([intent.q]))[0];
      const { text, values } = buildSelect(
        ctx.env,
        {
          collection: intent.collection,
          fields: selectFields,
          limit: intent.limit,
          offset: intent.offset,
        },
        grant.allowedFields,
        {
          q: intent.q,
          documentFilters: grant.documentFilter,
          isMultiValueField,
          searchFields: searchableFields,
          maskFor: plan.maskFor,
          mode,
          ...(qVector ? { qVector } : {}),
          ...g.aclOpts,
        },
      );
      const documents = await withWorkspace(
        dataPool(pools, ctx),
        ctx.workspaceId,
        async (client: PoolClient) => {
          return (await client.query(text, values)).rows;
        },
      );
      const rec = await audit.allow(intent.collection, {
        intent,
        fieldsReturned: selectFields,
        grant,
      });
      if (!rec.ok) return rec;
      return { ok: true, documents, fieldsReturned: selectFields, auditId: rec.auditId };
    } catch (err) {
      // Never surface a raw driver error: Postgres messages name columns, tables and
      // values, which is exactly what §10 test 4 forbids leaking. The audit row is
      // the non-negotiable part — an unaudited probe leaves no trace.
      console.error("[broker] searchDocuments failed", { collection: intent.collection, err });
      return audit.refuse(intent.collection, "internal_error", { intent, grant });
    }
  }

  /** Every collection the caller may read, merged by reciprocal-rank fusion. */
  async function searchAll(ctx: BrokerContext, intent: DocSearchIntent): Promise<BrokerResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    // The ceiling first, then the grants. `loadActiveGrants` applies the ceiling itself, so a
    // collection outside it is simply absent — the same narrowing every other verb gets.
    const names = Object.keys(cfg.collections);
    const grants = await loadActiveGrants(app, ctx, names);
    const reachable = names.filter((n) => grants.get(n)?.verbs.includes("read"));

    // Nothing to fan out to. Audited as one decision, because there was one: the caller holds no
    // read grant anywhere, which is not the same as twenty refusals.
    if (reachable.length === 0) {
      const rec = await audit.refuse("*", "no_grant", { intent });
      return rec;
    }

    const perCollection: SearchedCollection[] = [];
    const ranked: { doc: Document; collection: string; rank: number }[] = [];

    // Sequential, not parallel. Each hop opens its own transaction on the env-scoped pool, and
    // twenty at once against a pool sized for a request is how a search takes the whole app down.
    for (const name of reachable) {
      // A per-collection call, which means a per-collection audit row — including the refusals.
      // Collapsing twenty decisions into one is exactly what invariant 3 forbids.
      const one = await searchOne(ctx, {
        ...intent,
        collection: name,
        // The caller named no fields, so each collection projects what its own grant carries.
        // Naming fields across a fan-out would refuse every collection that lacks one of them.
        ...(intent.fields ? { fields: intent.fields } : {}),
      });
      if (!one.ok) {
        perCollection.push({
          collection: name,
          matched: 0,
          reason: one.reason,
          auditId: one.auditId,
        });
        continue;
      }
      perCollection.push({
        collection: name,
        matched: one.documents.length,
        reason: null,
        auditId: one.auditId,
      });
      one.documents.forEach((doc, i) => {
        // The document carries which collection it came from, because a merged result set with no
        // provenance is a list a caller cannot act on — `get_document` needs the collection.
        ranked.push({ doc: { ...doc, _collection: name }, collection: name, rank: i + 1 });
      });
    }

    const limit = intent.limit ?? DEFAULT_SEARCH_LIMIT;
    const merged = fuseByRank(ranked).slice(0, limit);

    // One more row for the fan-out itself, so the trail records that a single request reached N
    // collections rather than leaving N unrelated rows to be correlated by timestamp.
    const rec = await audit.allow("*", { intent, fieldsReturned: [] });
    if (!rec.ok) return rec;
    return {
      ok: true,
      documents: merged,
      // A merged set has no single field list — each document carries its own collection's.
      fieldsReturned: [],
      collections: perCollection,
      auditId: rec.auditId,
    };
  }

  // The full-document read. It shares query's prologue through the same guard — same grant, same
  // read verb, same field postures, same document filter — and differs only in how the target is
  // addressed and, for file collections, in reassembling the chunks back into one document.
  async function getDocument(
    ctx: BrokerContext,
    raw: GetDocumentIntent,
  ): Promise<GetDocumentResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const parsed = checkIntent(GetDocumentIntentSchema, raw, "getDocument");
    if (!parsed.ok) return audit.refuse(parsed.collection, "invalid_intent");
    const intent = parsed.intent;
    const c0 = findCollection(cfg, intent.collection);
    if (!c0) return audit.refuse(intent.collection, "unknown_collection");
    const chunked = kindOf(c0).chunked;
    // A path addresses a source file; a dataset has none. Asked before the grant so a caller that
    // addressed the wrong kind learns that rather than "no grant".
    if ("path" in intent && kindOf(c0).documentKey(c0, intent) === null)
      return audit.refuse(intent.collection, "invalid_intent");

    const g = await resolveGranted(d, audit, ctx, intent.collection, "read");
    if (!g.ok) return g;
    const { collection: c, grant, plan } = g;

    const all = Object.keys(c.fields);

    // How the caller names the document. Like documentFilter this is broker-supplied rather
    // than client-supplied, so it may reference a column outside allowedFields — a file's
    // `path` is commonly posture:deny yet is exactly how you address the file.
    //
    // Null means this kind cannot address the document the intent describes: a dataset with no
    // declared pk, or a `path` against a kind that has none.
    const key: Filter | null = kindOf(c).documentKey(c, intent);
    if (!key) return audit.refuse(intent.collection, "invalid_intent", { grant });

    const selectFields = grant.allowedFields.filter((f) => all.includes(f));

    try {
      // One file yields many documents, so the file form fetches every chunk in order and
      // rejoins them. A dataset document is a single row.
      const shaped: QueryIntent = chunked
        ? {
            collection: intent.collection,
            fields: selectFields,
            filters: [key],
            orderBy: { field: "document_seq", dir: "asc" },
            limit: MAX_LIMIT,
          }
        : { collection: intent.collection, fields: selectFields, filters: [key], limit: 1 };

      const { text, values } = buildSelect(ctx.env, shaped, grant.allowedFields, {
        documentFilters: grant.documentFilter,
        isMultiValueField,
        maskFor: plan.maskFor,
        ...g.aclOpts,
      });
      const rows = await withWorkspace(
        dataPool(pools, ctx),
        ctx.workspaceId,
        async (client: PoolClient) => (await client.query(text, values)).rows,
      );

      // Absent and excluded-by-filter are the same answer. Distinguishing them would make this
      // an existence oracle for documents the grant deliberately hides.
      if (rows.length === 0) return audit.refuse(intent.collection, "not_found", { grant });

      const document: Document = { ...rows[0] };
      if (chunked && selectFields.includes("content"))
        document.content = reassembleChunks(rows.map((r) => String(r.content ?? "")));

      const rev = chunked
        ? undefined
        : await currentRev(pools, ctx, intent.collection, c, (intent as { id: string }).id);

      const rec = await audit.allow(intent.collection, {
        fieldsReturned: selectFields,
        unmaskedFields: selectFields.filter((f) => grant.unmaskedFields.includes(f)),
        grant,
      });
      if (!rec.ok) return rec;
      return { ok: true, document, fieldsReturned: selectFields, rev, auditId: rec.auditId };
    } catch (err) {
      // Same discipline as query: a driver error names columns and values, so it goes to the
      // log and the caller gets a bare reason code. The audit row is written either way.
      console.error("[broker] getDocument failed", { collection: intent.collection, err });
      return audit.refuse(intent.collection, "internal_error", { grant });
    }
  }

  return { query, queryBatch, describeCollection, listCollections, searchDocuments, getDocument };
}

// The document's current revision id, or undefined where there is none to fetch.
//
// `_rev` only exists on writable dataset collections. It is a system field, not a granted one, and
// it is needed for concurrency control (ETag/If-Match) — which is not a field-value disclosure, in
// the same way MutationResult.rev is not. It comes through the WRITE pool because the read roles
// see views, and a view has no `_rev` column. Like listRevisions and listProposals, it degrades
// gracefully when no write pool is configured.
//
// Extracted rather than inlined: as four levels of nesting inside getDocument's try block it read
// as part of the read, which it is not — it is a second pool, a second transaction and one column.
async function currentRev(
  pools: Parameters<typeof writePool>[0],
  ctx: BrokerContext,
  collection: string,
  c: CollectionConfig,
  id: string,
): Promise<string | undefined> {
  if (!c.writable) return undefined;
  const pool = writePool(pools, ctx);
  if (!pool) return undefined;
  const pk = pkOf(c);
  if (!pk) return undefined;
  const schema = dataSchema(ctx.env);
  return withWorkspace(pool, ctx.workspaceId, async (client: PoolClient) => {
    const r = await client.query(
      `select _rev from ${schema}.${ident(collection)} where ${ident(pk)} = $1 and _current`,
      [id],
    );
    return r.rows[0]?._rev;
  });
}

// The default number of merged results a fan-out returns. Same as buildSelect's own default: a
// caller that named no limit on one collection did not mean "twenty times as many" on twenty.
const DEFAULT_SEARCH_LIMIT = 100;

/**
 * Reciprocal-rank fusion.
 *
 * The scores coming back from different collections are NOT comparable. `ts_rank` is computed
 * over that collection's own tsv column with its own document frequencies; a cosine distance is
 * computed over a different embedding set entirely. Averaging or thresholding them produces an
 * ordering that looks authoritative and is arbitrary.
 *
 * RRF throws the scores away and keeps the only comparable thing — where a document came in its
 * own collection's list — and sums 1/(k + rank). `k = 60` is the constant from the original
 * Cormack et al. paper and the one every implementation uses; it damps the top of each list so a
 * collection that returned one strong hit does not crowd out one that returned five good ones.
 */
const RRF_K = 60;

export function fuseByRank(
  entries: { doc: Document; collection: string; rank: number }[],
): Document[] {
  const scored = entries.map((e) => ({ doc: e.doc, score: 1 / (RRF_K + e.rank) }));
  // Stable: equal scores keep the order the collections were searched in, so a repeated query
  // returns a repeatable list rather than one that depends on the sort implementation.
  return scored
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((e) => e.doc);
}

// Every field named anywhere in the intent (fields, filters, orderBy, aggregate, groupBy).
export function collectReferenced(intent: QueryIntent): string[] {
  const s = new Set<string>();
  (intent.fields ?? []).forEach((f) => s.add(f));
  (intent.filters ?? []).forEach((f) => s.add(f.field));
  if (intent.orderBy) s.add(intent.orderBy.field);
  (intent.aggregate ?? []).forEach((a) => s.add(a.field));
  (intent.groupBy ?? []).forEach((f) => s.add(f));
  return [...s];
}

// The fields an intent COMPUTES over rather than merely projects: filters, ordering, aggregation
// and grouping. Everything in collectReferenced except `fields`.
//
// This split exists because masking is only sound for projection. A masked field the caller can
// still filter, order or aggregate on is not masked in any useful sense:
//
//   - `gt`/`lt` turn a bucketed salary into a binary search, ten queries to the exact figure;
//   - `like` walks a redacted name one character at a time;
//   - `orderBy` leaks the full ranking, which for a small collection is the values;
//   - `min`/`max` return the raw extremes outright, and `avg` of a masked column is a number
//     that looks masked and is not.
//
// So a masked field here is refused. Projection is the only thing a mask can survive.
export function collectComputed(intent: QueryIntent): string[] {
  const s = new Set<string>();
  (intent.filters ?? []).forEach((f) => s.add(f.field));
  if (intent.orderBy) s.add(intent.orderBy.field);
  (intent.aggregate ?? []).forEach((a) => s.add(a.field));
  (intent.groupBy ?? []).forEach((f) => s.add(f));
  return [...s];
}
