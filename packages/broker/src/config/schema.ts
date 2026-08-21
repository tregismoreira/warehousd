import { z } from "zod";
import { DB_PROVIDER_IDS, PROVISIONABLE_DB_PROVIDER_IDS } from "../db/providers";
import { DEPLOY_TARGET_IDS } from "./targets";
// A deliberate import cycle: rules/ states its `check` signature against `RawCollection` and reads
// this module's constants, and this module walks the registry. Both directions are used only from
// inside a function body — the rules run when a config is parsed, never at module evaluation — so
// neither binding is read before it exists.
import { collectionRules, runCollectionRules } from "./rules";
import { COLLECTION_KIND_IDS } from "./kinds/ids";
import { AUDIT_SINK_IDS, DEFAULT_AUDIT_SINK } from "../audit/sinks";

export const FILE_FIELDS = ["title", "content", "path", "owner", "updated_at"] as const;

// The per-document ACL, as a column on the view and as the table the rows live in.
//
// Structural in exactly the way `tsv`, `checksum` and `embedding` are: it names no configured
// field, so no grant can carry it and `buildSelect` can never project it — the select list is
// drawn from the YAML field set. Declared here rather than in apply/ddl.ts because "a collection
// may not have a field called this" is a config rule, and the DDL, the SQL builder and the
// in-process evaluator all have to spell it the same way.
export const ACL_COLUMN = "_acl";
export const ACL_TABLE = "_acl";

// Column names a vocabulary slug may never take: the fixed file fields plus
// structural columns emitted by document DDL/views and reserved result keys.
export const TAXONOMY_RESERVED_SLUGS = new Set<string>([
  ...FILE_FIELDS,
  "id",
  "checksum",
  "file_id",
  "document_seq",
  "tsv",
  "_rank",
  ACL_COLUMN,
]);

// Every part lands in a generated SQL identifier, so each is constrained to the same
// identifier shape field names use. Nothing here may reach SQL unvalidated.
const IDENT = /^[a-z_][a-z0-9_]*$/i;

export const TermSchema = z.object({ label: z.string() }).strict();
export const VocabularySchema = z
  .object({
    label: z.string(),
    multiple: z.boolean().default(false),
    terms: z.record(z.string(), TermSchema).optional(),
    // syncDatasetTerms interpolates all three into a select. The cross-reference check in
    // ConfigSchema proves they name something real; these prove they are safe to quote.
    source: z
      .object({
        collection: z.string().regex(IDENT),
        slug: z.string().regex(IDENT),
        label: z.string().regex(IDENT),
      })
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasTerms = !!v.terms;
    const hasSource = !!v.source;
    if (!hasTerms && !hasSource)
      ctx.addIssue({
        code: "custom",
        message: `vocabulary must declare either "terms" (YAML) or "source" (dataset)`,
      });
    if (hasTerms && hasSource)
      ctx.addIssue({
        code: "custom",
        message: `vocabulary must declare either "terms" (YAML) or "source" (dataset), not both`,
      });
  });
export type VocabularyConfig = z.infer<typeof VocabularySchema>;
export const ViewJoinSchema = z
  .object({
    table: z.string().regex(IDENT),
    column: z.string().regex(IDENT),
    on: z.string().regex(IDENT),
  })
  .strict();
export type ViewJoinConfig = z.infer<typeof ViewJoinSchema>;

// The read axis has three settings, not two. `mask` is a THIRD state between allow and deny:
// the field is grantable, and what a grant gets back is a transformed value rather than the
// stored one. It is not "allow with a filter applied afterwards" — the transform is computed in
// SQL, so the raw value never leaves Postgres (see sql/mask.ts).
//
// `unmask` is a separate axis for the same reason `write` is: it answers a different question.
// `read: mask` says what everyone gets. `unmask: allow` says the raw value is *grantable* — a
// manager must still tick it per grant, exactly as `read: allow` only makes a field grantable
// rather than readable. It defaults to `deny`, so declaring a mask and stopping there means
// nobody sees raw without editing this file.
export const READ_POSTURES = ["allow", "mask", "deny"] as const;
const PostureSchema = z.union([
  z.enum(["allow", "deny"]),
  z.object({
    read: z.enum(READ_POSTURES),
    write: z.enum(["allow", "deny"]),
    unmask: z.enum(["allow", "deny"]).default("deny"),
  }),
]);

// The transforms a masked field may take, as a closed set. Each carries its own parameters, so a
// `bucket` without a width or a `first` without a length is a config error rather than a runtime
// surprise. sql/mask.ts turns each of these into one SQL expression and nothing else can.
export const MaskSchema = z.discriminatedUnion("transform", [
  // Any type. A fixed token, so the value is gone rather than merely obscured.
  z.object({ transform: z.literal("redact") }).strict(),
  // text. Keeps the last four characters — the account-number convention.
  z.object({ transform: z.literal("last4") }).strict(),
  // text. Keeps a prefix.
  z.object({ transform: z.literal("first"), chars: z.number().int().min(1).max(64) }).strict(),
  // Any type. A stable pseudonym: equal values hash equal, so rows can be correlated without
  // any of them being readable. Keyed per deployment — see WAREHOUSD_MASK_KEY.
  z.object({ transform: z.literal("hash") }).strict(),
  // numeric/int. Quantises into bands: 97_300 with width 25_000 reads 75_000.
  z.object({ transform: z.literal("bucket"), width: z.number().positive() }).strict(),
  // date/timestamptz. The year alone.
  z.object({ transform: z.literal("year") }).strict(),
  // text. The part of an email address after the @.
  z.object({ transform: z.literal("domain") }).strict(),
]);
export type MaskConfig = z.infer<typeof MaskSchema>;

// Which column types each transform can be computed over. `redact` and `hash` are absent because
// they apply to anything: one replaces the value outright, the other casts to text first.
//
// Exported for config/rules/mask.ts, which is where the rule that reads it now lives.
export const MASK_TYPES: Record<string, readonly string[]> = {
  last4: ["text"],
  first: ["text"],
  domain: ["text"],
  bucket: ["numeric", "int"],
  year: ["date", "timestamptz"],
};

/**
 * What a relation exposes from its target, and under what posture.
 *
 * The host names each target field it surfaces and gives it a posture of its own. That is what
 * "host-governed" means: the relation is a field-set on the host, not a window into the target,
 * and no grant on the target collection is consulted. A target field the host does not name has
 * no posture here, so there would be nothing to decide with — which is why the list is explicit
 * rather than "everything the target has".
 */
export const RelationSelectSchema = z
  .record(
    z.string().regex(IDENT),
    z
      .object({
        posture: PostureSchema,
        mask: MaskSchema.optional(),
      })
      .strict(),
  )
  .refine((s) => Object.keys(s).length > 0, "a relation must select at least one field");

/**
 * The most documents one relation may pull per host document.
 *
 * A ceiling rather than a default. One request may carry MAX_BATCH_QUERIES labelled queries, each
 * returning up to MAX_LIMIT documents, each expanding its relations — so an uncapped to-many
 * turns one HTTP call into an unbounded read on a pool sized for one request. Enforced here, at
 * config load, because a query-time cap would have to be reasoned about at every call site.
 */
export const RELATION_MAX_LIMIT = 50;

export const RelationOrderSchema = z
  .object({
    field: z.string().regex(IDENT),
    dir: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

/**
 * A field that composes documents from another collection.
 *
 * Projection only, exactly as `view_join` is, and for the same reason: there is no column on the
 * base table for a write to land in. Resolved at query time against the TARGET'S VIEW rather
 * than its table, which is what makes it inherit the target's current-revision filter, its
 * workspace predicate and its per-document ACL instead of having to restate all three.
 */
const RelationToOneSchema = z
  .object({
    collection: z.string().regex(IDENT),
    /** The local field carrying `fk: <collection>.<column>`. */
    on: z.string().regex(IDENT),
    select: RelationSelectSchema,
  })
  .strict();

/**
 * The to-many form. `via` is the TARGET's field pointing back at this collection.
 *
 * `limit` and `order` are both required, and neither has a default. A truncated list whose order
 * nobody chose is arbitrary, and an untruncated one is unbounded — so the two are required
 * together or the answer is meaningless.
 */
const RelationToManySchema = z
  .object({
    collection: z.string().regex(IDENT),
    via: z.string().regex(IDENT),
    select: RelationSelectSchema,
    limit: z.number().int().positive().max(RELATION_MAX_LIMIT),
    order: RelationOrderSchema,
  })
  .strict();

export const RelationSchema = z.union([RelationToOneSchema, RelationToManySchema]);
export type RelationDef = z.infer<typeof RelationSchema>;

export function isToMany(r: RelationDef): r is z.infer<typeof RelationToManySchema> {
  return "via" in r;
}

// Every object in this file is strict: an unrecognised key in warehousd.yml is a typo, and the
// cost of ignoring one is not a validation error but a silent policy change. `postur: deny` parses
// as a field with no posture declared, and a field with no posture is not a field that denies —
// it is a field whose posture came from somewhere else, or defaulted. The same reasoning does NOT
// apply to the intent schemas in intents/schema.ts, which deliberately ignore unknown keys because
// a client sending an extra key must not be able to tell the difference (see the comment there).
export const FieldSchema = z
  .object({
    type: z
      .enum(["uuid", "text", "numeric", "int", "timestamptz", "date", "boolean", "json"])
      .optional(),
    posture: PostureSchema,
    mask: MaskSchema.optional(), // required by, and only valid with, read: mask
    // The column's name on the REMOTE table, when it differs from the field name. Only
    // meaningful on a collection with `source_ref`. Declared explicitly rather than imported so
    // a column added upstream never silently appears in warehousd.
    column: z.string().regex(IDENT).optional(),
    pk: z.boolean().optional(),
    fk: z.string().optional(), // "people.id"
    view_join: ViewJoinSchema.optional(), // { table: "people", column: "full_name", on: "responsible_attorney_id" }
    relation: RelationSchema.optional(),
    nullable: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    gen: z.string().optional(),
    searchable: z.boolean().optional(), // datasets only, text fields only
  })
  .strict();
export type FieldConfig = z.infer<typeof FieldSchema>;

// The types a file collection's extra (metadata) fields may take. `uuid` and `json` are
// excluded deliberately: frontmatter is hand-written prose, not a serialisation format.
export const FILE_METADATA_TYPES = [
  "text",
  "date",
  "timestamptz",
  "numeric",
  "int",
  "boolean",
] as const;
export type FileMetadataType = (typeof FILE_METADATA_TYPES)[number];

export const FILE_FIELD_TYPES: Record<(typeof FILE_FIELDS)[number], FieldConfig["type"]> = {
  title: "text",
  content: "text",
  path: "text",
  owner: "text",
  updated_at: "timestamptz",
};

export type ReadPosture = (typeof READ_POSTURES)[number];
export type NormalizedPosture = {
  read: ReadPosture;
  write: "allow" | "deny";
  unmask: "allow" | "deny";
};

// Every unrecognised shape lands on deny/deny/deny. That is the whole point of doing this in one
// function: a posture arrived at by omission is the closed one, not the open one.
export function normalizePosture(p: unknown): NormalizedPosture {
  if (typeof p === "string")
    return { read: p === "allow" ? "allow" : "deny", write: "deny", unmask: "deny" };
  if (typeof p === "object" && p !== null && "read" in p && "write" in p) {
    const o = p as { read?: unknown; write?: unknown; unmask?: unknown };
    const read = (READ_POSTURES as readonly unknown[]).includes(o.read)
      ? (o.read as ReadPosture)
      : "deny";
    return {
      read,
      write: o.write === "allow" ? "allow" : "deny",
      // Only meaningful alongside `read: mask`, and refused by CollectionSchema otherwise — but
      // pinned closed here too, so a posture that never went through the schema cannot arrive
      // carrying an unmask nobody validated.
      unmask: read === "mask" && o.unmask === "allow" ? "allow" : "deny",
    };
  }
  return { read: "deny", write: "deny", unmask: "deny" };
}

export function readPosture(f: FieldConfig): ReadPosture {
  return normalizePosture(f.posture).read;
}

export function writePosture(f: FieldConfig): "allow" | "deny" {
  return normalizePosture(f.posture).write;
}

// Whether the RAW value of a masked field may be granted. Never true for an unmasked field:
// `read: allow` already returns raw, and `read: deny` has nothing to unmask.
export function unmaskPosture(f: FieldConfig): "allow" | "deny" {
  return normalizePosture(f.posture).unmask;
}

// A field is grantable when it can be read at all — masked or not. `mask` is a disclosure level,
// not a refusal, so a masked field belongs in the set a manager can approve.
export function isGrantable(f: FieldConfig): boolean {
  return readPosture(f) !== "deny";
}

// An external Postgres warehousd reads through rather than copies from.
//
// The connection is made by the DATABASE, via postgres_fdw, not by the broker. That is the whole
// design: a foreign table lives inside data_live, so the collection's view, its grant, its RLS
// policy, `dataPool` and `buildSelect` all work on it unchanged. A second connection pool in the
// broker would have needed a variant of every one of those, which is four new ways to get
// tenant isolation wrong.
export const SourceSchema = z
  .object({
    type: z.literal("postgres"),
    // Interpolated by ${env:VAR} at load time. It reaches Postgres as a user mapping, which only
    // the mapping's owner can read back — it is never stored in a warehousd table.
    //
    // Resolved BY POSTGRES, not by warehousd: the host and port have to be reachable from the
    // database server, which is not always the address your client uses. A warehousd running its
    // own Postgres in a container cannot reach a source published on that container's host port.
    url: z.string(),
    schema: z.string().regex(IDENT).default("public"),
    // Read-only is the default and turning it off is not implemented: writing into someone
    // else's database through a governed layer is a different feature with different questions
    // (who owns the transaction, what happens to a failed write's audit row) and pretending
    // otherwise by flipping a flag would be worse than not offering it.
    read_only: z.literal(true).default(true),
  })
  .strict();
export type SourceConfig = z.infer<typeof SourceSchema>;

// Where a collection's rows actually live, when they do not live in warehousd.
export const SourceRefSchema = z
  .object({
    source: z.string(),
    table: z.string().regex(IDENT),
    // The workspace every row of the remote table belongs to. A foreign table has no workspace_id column to
    // filter on, so the view compares this constant against the request's workspace instead — see
    // viewDDL. Declaring it is what keeps an external collection inside the tenant model rather
    // than beside it.
    workspace: z.string().default("default"),
  })
  .strict();
export type SourceRefConfig = z.infer<typeof SourceRefSchema>;

// How a spreadsheet's headers map onto this collection's fields, for `warehousd import`.
//
// Resolved before the field lookup in `validateImportRows`, so `Base Salary (USD)` reaches
// `base_salary` rather than reporting `unknown_column`. Governed in git like the rest of the
// config — see config/rules/import.ts for why this is not `FieldSchema.column`.
export const ImportSchema = z
  .object({ columns: z.record(z.string(), z.string()).default({}) })
  .strict();
export type ImportConfig = z.infer<typeof ImportSchema>;

/**
 * A declared index on a dataset collection.
 *
 * Btree only, and never unique. A unique index on a revisioned table would have to be partial on
 * `_current` to mean anything, and `applyConfig` cannot safely add a data constraint to a
 * collection that already holds documents — that is a `warehousd migrate` question, not an
 * `apply` one. The declared primary key is appended by the DDL rather than written here, so an
 * operator cannot omit the column keyset pagination needs.
 */
export const IndexSchema = z
  .object({
    fields: z.array(z.string().regex(IDENT)).min(1).max(4),
  })
  .strict();
export type IndexDef = z.infer<typeof IndexSchema>;

// The collection as the author wrote it: parsed and defaulted, but before the rules run and before
// `.transform` normalises postures and fills types.
//
// Split out from CollectionSchema so config/rules/ has a type to state its `check` signature
// against without reaching into a `.superRefine` chain.
export const CollectionBaseSchema = z
  .object({
    description: z.string(),
    // From the registry, not a hand-written list: a fourth kind must not be able to exist in
    // config/kinds/ and be rejected by the schema. See config/kinds/index.ts.
    type: z.enum(COLLECTION_KIND_IDS).default("dataset"),
    source: z.string().optional(),
    source_live: z.string().optional(),
    source_ref: SourceRefSchema.optional(),
    taxonomies: z.array(z.string()).default([]), // vocabulary slugs — validated against `taxonomies` at ConfigSchema level
    indexes: z.array(IndexSchema).default([]),
    writable: z.boolean().optional(), // opt-in to write path; verb support is structural
    // Per-document ACLs. Off unless a collection asks for them, because turning them on costs a
    // join on every read of the collection and a document with no ACL row is readable by anyone
    // the grant covers — so a project that never restricts an individual document pays nothing.
    //
    // The rule, once on: a document with no ACL is readable by anyone the grant covers; a document
    // WITH an ACL is readable only by the principals listed on it. See docs/architecture.md.
    acl: z.boolean().default(false),
    /**
     * How long an approved grant on this collection lasts, in days, when the approver names no
     * expiry of their own.
     *
     * `expires_at` was enforced at query time and rendered in two tables, and that was all of it:
     * no default, no notification, no re-attestation, no sweep. Access granted for a one-off
     * purpose was permanent unless a human remembered — which is the opposite of what a
     * purpose-bound grant is supposed to mean.
     *
     * Absent means no default, which is what every collection had before. It is per collection
     * because the answer is not uniform: a salaries collection wants thirty days and a public
     * announcements one wants none.
     */
    grant_expiry_days: z.number().int().positive().max(3650).optional(),
    import: ImportSchema.optional(),
    fields: z.record(z.string(), FieldSchema),
  })
  .strict();
export type RawCollection = z.infer<typeof CollectionBaseSchema>;

// Every rule about a collection lives in config/rules/ and is registered in `collectionRules()`.
// This callback does nothing but walk that list — see the comment on the registry for why.
export const CollectionSchema = CollectionBaseSchema.superRefine((c, ctx) => {
  runCollectionRules(collectionRules(), c, ctx);
}).transform((c) => {
  const fields = Object.fromEntries(
    Object.entries(c.fields).map(([k, f]) => [
      k,
      {
        ...f,
        // Normalize posture to canonical {read, write, unmask} form
        posture: normalizePosture(f.posture),
      },
    ]),
  );

  // Bound term fields: auto-add as text/allow when omitted; fill type text when untyped.
  for (const taxSlug of c.taxonomies) {
    const tf = fields[taxSlug];
    fields[taxSlug] = tf
      ? {
          ...tf,
          type: tf.type ?? "text",
        }
      : { posture: { read: "allow", write: "deny", unmask: "deny" }, type: "text" };
  }
  if (c.type !== "file") return { ...c, fields };
  const filled = Object.fromEntries(
    Object.entries(fields).map(([k, f]) => [
      k,
      { ...f, type: f.type ?? FILE_FIELD_TYPES[k as (typeof FILE_FIELDS)[number]] ?? "text" },
    ]),
  );
  return { ...c, fields: filled };
});

// Cloud deploy target. Declared before ConfigSchema because ConfigSchema references it: a `const`
// sits in the temporal dead zone until its initialiser runs, and both are evaluated at import.
//
// `database` takes exactly one of `managed: true` (provision Postgres on the target) or `url`
// (attach one you already run). Neither leaves the deployment with no database and no error until
// the release command fails; both is ambiguous about which one wins, and the answer would only
// show up as data written to the wrong place.
//
// `image` overrides the published server image. It exists so a deploy can run against a locally
// built or otherwise unpublished base — the same need `server.image` covers for the local CLI.
//
// `database.provider` names where that url is hosted, and is only ever an override: the host
// normally says so on its own (db/providers/index.ts, detectProvider). It exists for a url that
// does not advertise it — a CNAME, a proxy — where the wrong answer is not a parse error but a
// role that cannot authenticate. See docs/deploy-database.md.
//
// `region` is only checked for being present. Its *shape* belongs to the target and is checked by
// the target's pre-flight (packages/cli/src/deploy/targets), which can say "gru, iad" for Fly and
// "us-west2" for somewhere else. A schema that knew one target's slug format would have to be
// edited for every new one, and would report a bad region as a config parse error instead of a
// named pre-flight refusal.
export const DeploySchema = z
  .object({
    target: z.enum(DEPLOY_TARGET_IDS),
    // A DNS label, which is what every target makes of this name: Fly's app name, Railway's
    // project name, a Compose service. The rule is generic on purpose — the message used to say
    // "a valid Fly app name", which named one target in a schema that validates all of them.
    app_name: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]{0,62}$/,
        "app_name must be a valid host name (lowercase letters, digits and dashes, starting with a letter or digit)",
      ),
    // Optional because not every target has regions — Compose runs wherever the operator runs it.
    // A target that does need one refuses its absence in `preflight`, with its own message.
    region: z.string().min(1, "region must not be empty").optional(),
    image: z.string().optional(),
    database: z
      .object({
        managed: z.boolean().optional(),
        url: z.string().optional(),
        provider: z.enum(DB_PROVIDER_IDS).optional(),
        // The *database's* region, which is not the deploy target's. Supabase says `sa-east-1`
        // and Neon `aws-us-east-1`, neither of which is a Fly `gru` or a Railway `us-west2`;
        // reusing `region` above would ask a provider to build somewhere it has nothing. Shape
        // unchecked here for the same reason `region` is — the host refuses its own, by name.
        region: z.string().min(1, "database region must not be empty").optional(),
        // Supabase alone needs this, and only when the account has more than one organisation.
        org: z.string().min(1, "database org must not be empty").optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const managed = d.database.managed === true;
    const hasUrl = typeof d.database.url === "string" && d.database.url.length > 0;
    if (managed === hasUrl)
      ctx.addIssue({
        code: "custom",
        message: "deploy.database requires exactly one of `managed: true` or `url`",
      });

    // `provider` now answers two different questions depending on the company it keeps, and only
    // one combination is meaningless.
    //
    //   url + provider      — who *hosts* the database you attached. An override; the host
    //                         normally says so itself.
    //   managed + provider  — who should *create* it, using their own CLI.
    //   managed alone       — the deploy target creates it, as it always has.
    //
    // The meaningless one is `managed` with a provider that cannot create anything: `generic`
    // names no CLI, and `railway` is provisioned by the Railway *target* rather than twice.
    if (
      managed &&
      d.database.provider &&
      !PROVISIONABLE_DB_PROVIDER_IDS.includes(d.database.provider)
    )
      ctx.addIssue({
        code: "custom",
        message:
          `deploy.database.provider \`${d.database.provider}\` cannot provision a database — ` +
          `warehousd has no CLI for it. Use one of ${PROVISIONABLE_DB_PROVIDER_IDS.join(", ")}, ` +
          `drop the key to let the deploy target provision it, or set a \`url\` instead.`,
      });

    // A region or an org with nothing to build is a key that decides nothing while reading as
    // though it did — the same objection the old `provider`-without-`url` rule made.
    for (const key of ["region", "org"] as const) {
      if (d.database[key] !== undefined && !(managed && d.database.provider))
        ctx.addIssue({
          code: "custom",
          message: `deploy.database.${key} only applies with \`managed: true\` and a \`provider\` that creates the database`,
        });
    }
  });
export type DeployConfig = z.infer<typeof DeploySchema>;

// Semantic search, off unless declared. Absent means `search_documents` behaves exactly as it
// always has and the embedding column stays unpopulated — which is the honest default, because
// embedding a corpus is a decision with a cost and, for a remote provider, a disclosure.
//
// `dimensions` has no default on purpose. It has to match the model, and getting it wrong shows
// up from Postgres as a cast error on the insert that names neither the model nor this key.
export const EmbeddingSchema = z
  .object({
    provider: z.enum(["local", "openai", "http"]).default("local"),
    model: z.string(),
    dimensions: z.number().int().positive().max(4096),
    base_url: z.string().optional(),
    api_key: z.string().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.provider === "http" && !e.base_url)
      ctx.addIssue({
        code: "custom",
        message: "embedding.provider `http` requires `base_url`",
      });
    // Local runs in-process and has nothing to authenticate to. Accepting a key here would read
    // as "this is configured" while the key went nowhere.
    if (e.provider === "local" && (e.base_url || e.api_key))
      ctx.addIssue({
        code: "custom",
        message: "embedding.provider `local` takes neither `base_url` nor `api_key`",
      });
  });
export type EmbeddingConfig = z.infer<typeof EmbeddingSchema>;

// admin ⊃ manager ⊃ member, the same order apps/web/lib/authz.ts ranks them in.
export const APP_ROLES = ["member", "manager", "admin"] as const;
export type AppRole = (typeof APP_ROLES)[number];

// Which IdP groups map to which warehousd role, per provider.
//
// This lives in warehousd.yml rather than alongside the provider registration on purpose. A
// provider is registered at runtime through the admin API; the YAML is operator-controlled trusted
// input (see SECURITY.md, "Deployment expectations"). A mapping that decides who becomes an admin
// belongs in the trusted file, not in a row an API call writes.
//
// `groups` is keyed by the IdP's group name and never the other way round: two groups mapping to
// the same role is ordinary, and a role appearing twice as a key would silently drop one.
export const SsoProviderSchema = z
  .object({
    // The claim (OIDC) or attribute (SAML) carrying the caller's groups. It must also be mapped
    // into `userInfo` by the provider registration's `mapping.extraFields` — better-auth passes
    // the provisioning hook a mapped object, not the raw claim set, so an unmapped claim is not
    // merely unread here, it never arrives.
    group_claim: z.string().min(1),
    groups: z.record(z.string(), z.enum(APP_ROLES)),
    // What a user in none of the mapped groups gets. `member` — the role JIT provisioning has
    // always produced — so adding a mapping cannot accidentally lock an existing population out.
    default_role: z.enum(APP_ROLES).default("member"),
  })
  .strict();
export type SsoProviderConfig = z.infer<typeof SsoProviderSchema>;

export const SsoSchema = z
  .object({
    // Keyed by `providerId` — the same string the admin API registers the provider under.
    providers: z.record(z.string(), SsoProviderSchema).default({}),
  })
  .strict();

/**
 * The audit trail: whether it is written at all, and where it goes.
 *
 * `enabled: false` is for lower environments — nothing is recorded, allows and refusals alike, and
 * every result's `auditId` comes back null. Read it through `auditEnabled()` in config/load.ts.
 *
 * `sink` decides the destination. `postgres` is the default and the only one the console can
 * query: the audit browser and the access-review view read `app.audit_events`, so a deployment
 * that forwards elsewhere keeps the trail and loses the console's view of it. That is a real
 * trade-off and it belongs in the config, said out loud. See audit/sinks/.
 *
 * Whatever the sink, the rule that makes the trail worth having is unchanged: a decision that
 * could not be recorded is not an allow.
 */
export const AuditSchema = z
  .object({
    enabled: z.boolean().default(true),
    sink: z.enum(AUDIT_SINK_IDS).default(DEFAULT_AUDIT_SINK),
    // `webhook` only. Interpolated by ${env:VAR} at load time like every other url here.
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // `webhook` only. How long to wait for the collector before treating the write as failed —
    // which, under the downgrade rule, refuses the call. Capped at a minute because a longer
    // deadline is not a slower collector, it is a hung one nobody noticed. See audit/sinks/.
    timeout_ms: z.number().int().positive().max(60_000).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.sink === "webhook" && !a.url)
      ctx.addIssue({ code: "custom", message: "audit.sink `webhook` requires `audit.url`" });
    // A url against a sink that makes no request configures nothing while reading as though it
    // did — the same rule `embedding.provider local` already states about `base_url`.
    if (a.sink !== "webhook" && (a.url || a.headers))
      ctx.addIssue({
        code: "custom",
        message: `audit.sink \`${a.sink}\` takes neither \`url\` nor \`headers\``,
      });
    if (a.sink !== "webhook" && a.timeout_ms !== undefined)
      ctx.addIssue({
        code: "custom",
        message: `audit.sink \`${a.sink}\` makes no request, so \`timeout_ms\` configures nothing`,
      });
  });
export type AuditConfig = z.infer<typeof AuditSchema>;

/**
 * The platform provisioning API (`/v1/platform/*`, `warehousd platform-key`).
 *
 * Off by default. A single enterprise's self-hosted deployment — the primary shape of this
 * product — has exactly one workspace and no reason to carry a provisioning API. Turning this on
 * adds no enforcement and removes none: workspace isolation (RLS, view predicates, withWorkspace,
 * membership-based role resolution, resolveWorkspace) runs unconditionally in both states. What
 * the flag gates is documented beside `workspacesEnabled()` in config/load.ts.
 */
export const WorkspacesSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict();
export type WorkspacesConfig = z.infer<typeof WorkspacesSchema>;

export const ConfigSchema = z
  .object({
    project: z.string(),
    // Seed the §9 demo personas on first boot. Off by default: a consuming project must opt in.
    demo: z.boolean().default(false),
    // The audit trail. On unless a project turns it off, and turning it off is for lower
    // environments: nothing is recorded — allows, refusals and imports alike — and every result's
    // auditId comes back null. Read it through `auditEnabled()` in config/load.ts rather than
    // directly; see the note there.
    audit: AuditSchema.default({ enabled: true, sink: "postgres" }),
    // The database on *this machine*, which is a different question from `deploy.database` and
    // was once answered by the same flag. `managed: true` runs Postgres for you; `url` points at
    // one you already have; `provider` picks *whose* local stack does the running.
    database: z
      .object({
        managed: z.boolean().optional(),
        url: z.string().optional(),
        // Host port for the CLI-managed Postgres. Default (server.port + 1) is applied in the CLI,
        // not here, because it depends on a sibling field.
        port: z.number().optional(),
        // Whose local stack, when it is not warehousd's own pgvector container.
        //
        // `supabase` runs `supabase start`, which is worth the extra weight for one reason: it
        // installs pgcrypto into an `extensions` schema rather than `public`, exactly as the
        // hosted product does. That is the difference behind the failure docs/deploy-database.md
        // calls the bad one — apply succeeds, boot succeeds, and the first masked read fails at
        // request time. Reproducing it locally is the point.
        //
        // Not every provider has a local stack; the CLI refuses one that does not, by name.
        provider: z.enum(DB_PROVIDER_IDS).optional(),
      })
      .strict()
      .optional()
      .superRefine((d, ctx) => {
        if (!d) return;
        // A provider decides who runs the database, so it says nothing about one you point at.
        if (d.provider && typeof d.url === "string" && d.url.length > 0)
          ctx.addIssue({
            code: "custom",
            message:
              "database.provider names who runs the local database, so it does not apply alongside `url` — drop one of them",
          });
      }),
    server: z
      .object({
        port: z.number(),
        // Override the published server image (CI/E2E point this at a locally built tag).
        image: z.string().optional(),
      })
      .default({ port: 8722 }),
    taxonomies: z
      .record(z.string(), VocabularySchema)
      .default({})
      .superRefine((tx, ctx) => {
        for (const [slug, v] of Object.entries(tx)) {
          if (
            !/^[a-z][a-z0-9_]*$/.test(slug) ||
            slug.includes("__") ||
            TAXONOMY_RESERVED_SLUGS.has(slug)
          )
            ctx.addIssue({
              code: "custom",
              message: `vocabulary slug "${slug}" invalid (must match [a-z][a-z0-9_]*, no "__", not a reserved column name)`,
            });
          if (v.terms) {
            for (const t of Object.keys(v.terms))
              if (!/^[a-z0-9][a-z0-9-]*$/.test(t))
                ctx.addIssue({
                  code: "custom",
                  message: `term slug "${t}" in vocabulary "${slug}" must be lowercase kebab-case`,
                });
          }
        }
      }),
    collections: z.record(z.string(), CollectionSchema).superRefine((cols, ctx) => {
      for (const name of Object.keys(cols)) {
        if (name.includes("__"))
          ctx.addIssue({
            code: "custom",
            message: `collection name "${name}" must not contain "__" (reserved)`,
          });
        // A collection name becomes a table name, and apply/ddl.ts interpolates some of those
        // unquoted. Field names have always been held to this shape; collection names were not.
        if (!IDENT.test(name))
          ctx.addIssue({
            code: "custom",
            message: `collection name "${name}" invalid (must match [a-z_][a-z0-9_]*)`,
          });
      }
    }),
    sources: z.record(z.string().regex(IDENT), SourceSchema).default({}),
    synthetic: z
      .object({ documents_per_collection: z.record(z.string(), z.number()).default({}) })
      .default({ documents_per_collection: {} }),
    embedding: EmbeddingSchema.optional(),
    sso: SsoSchema.optional(),
    workspaces: WorkspacesSchema.default({ enabled: false }),
    deploy: DeploySchema.optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const [name, c] of Object.entries(cfg.collections)) {
      if (c.source_ref && !cfg.sources[c.source_ref.source])
        ctx.addIssue({
          code: "custom",
          message: `collection "${name}" references unknown source "${c.source_ref.source}"`,
        });
      // Validate that each bound taxonomy exists
      for (const taxSlug of c.taxonomies) {
        if (!cfg.taxonomies[taxSlug])
          ctx.addIssue({
            code: "custom",
            message: `collection "${name}" binds unknown vocabulary "${taxSlug}"`,
          });
      }
      // Validate dataset-sourced vocabularies reference valid collections and fields
      for (const taxSlug of c.taxonomies) {
        const vocab = cfg.taxonomies[taxSlug];
        if (vocab?.source) {
          const srcCol = cfg.collections[vocab.source.collection];
          if (!srcCol)
            ctx.addIssue({
              code: "custom",
              message: `vocabulary "${taxSlug}" references unknown source collection "${vocab.source.collection}"`,
            });
          else if (srcCol.type !== "dataset")
            ctx.addIssue({
              code: "custom",
              message: `vocabulary "${taxSlug}" source collection "${vocab.source.collection}" must be type dataset`,
            });
          else if (!srcCol.fields[vocab.source.slug] || !srcCol.fields[vocab.source.label])
            ctx.addIssue({
              code: "custom",
              message: `vocabulary "${taxSlug}" source fields (slug: "${vocab.source.slug}", label: "${vocab.source.label}") not found in collection "${vocab.source.collection}"`,
            });
        }
      }
    }
    // Cross-collection relation checks. A CollectionRule sees one collection; these need both.
    for (const [cname, c] of Object.entries(cfg.collections)) {
      for (const [fname, f] of Object.entries(c.fields)) {
        const rel = f.relation;
        if (!rel) continue;
        const target = cfg.collections[rel.collection];
        if (!target) {
          ctx.addIssue({
            code: "custom",
            message: `${cname}.${fname} relates to unknown collection "${rel.collection}"`,
          });
          continue;
        }
        if (target.type !== "dataset") {
          ctx.addIssue({
            code: "custom",
            message: `${cname}.${fname} relates to "${rel.collection}", which is not a dataset collection`,
          });
          continue;
        }
        for (const sub of Object.keys(rel.select)) {
          const tf = target.fields[sub];
          if (!tf) {
            ctx.addIssue({
              code: "custom",
              message: `${cname}.${fname} selects "${sub}" but target collection "${rel.collection}" has no field "${sub}"`,
            });
            continue;
          }
          if (tf.relation)
            ctx.addIssue({
              code: "custom",
              message: `${cname}.${fname} selects "${sub}", which is itself a relation; a relation reaches one collection, not a chain`,
            });
        }

        if (isToMany(rel)) {
          const via = target.fields[rel.via];
          if (!via) {
            ctx.addIssue({
              code: "custom",
              message: `${cname}.${fname} relates via "${rel.via}", which target collection "${rel.collection}" does not have`,
            });
          } else if (!via.fk || !via.fk.startsWith(`${cname}.`)) {
            ctx.addIssue({
              code: "custom",
              message: `${cname}.${fname} relates via "${rel.collection}.${rel.via}", which does not have fk pointing at ${cname}`,
            });
          }
          if (!target.fields[rel.order.field])
            ctx.addIssue({
              code: "custom",
              message: `${cname}.${fname} orders by "${rel.order.field}", which target collection "${rel.collection}" does not have`,
            });

          // A to-many resolves one subquery per host document, so an unindexed back-reference
          // turns a page of 100 documents into 100 sequential scans of the target. Refusing at
          // config load turns a performance trap into an error naming both sides — the only place
          // a person can still fix it cheaply.
          const covered = (target.indexes ?? []).some((i) => i.fields[0] === rel.via);
          if (!covered)
            ctx.addIssue({
              code: "custom",
              message: `${cname}.${fname} relates via "${rel.collection}.${rel.via}", which is not indexed; add "- fields: [${rel.via}]" to ${rel.collection}.indexes`,
            });
        }
      }
    }
  });
export type WarehousdConfig = z.infer<typeof ConfigSchema>;

export type CollectionConfig = WarehousdConfig["collections"][string];

// The typed extra fields a file collection declares beyond FILE_FIELDS and its bound
// vocabularies. Single source of truth: the DDL, the indexer and the CLI must agree exactly
// on this set, or a declared field ends up with a column and no value — or a value and no column.
export function fileMetadataFields(
  c: CollectionConfig,
): { field: string; type: FileMetadataType }[] {
  const fixed = new Set<string>([...FILE_FIELDS, ...(c.taxonomies ?? [])]);
  const allowed = new Set<string>(FILE_METADATA_TYPES);
  return Object.entries(c.fields)
    .filter(([k, f]) => !fixed.has(k) && !!f.type && allowed.has(f.type))
    .map(([k, f]) => ({ field: k, type: f.type as FileMetadataType }));
}
