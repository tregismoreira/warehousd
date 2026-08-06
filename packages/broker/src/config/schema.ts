import { z } from "zod";
import { DB_PROVIDER_IDS } from "../db/providers";
import { DEPLOY_TARGET_IDS } from "./targets";

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
const MASK_TYPES: Record<string, readonly string[]> = {
  last4: ["text"],
  first: ["text"],
  domain: ["text"],
  bucket: ["numeric", "int"],
  year: ["date", "timestamptz"],
};

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
    // The org every row of the remote table belongs to. A foreign table has no org_id column to
    // filter on, so the view compares this constant against the request's org instead — see
    // viewDDL. Declaring it is what keeps an external collection inside the tenant model rather
    // than beside it.
    org: z.string().default("default"),
  })
  .strict();
export type SourceRefConfig = z.infer<typeof SourceRefSchema>;

export const CollectionSchema = z
  .object({
    description: z.string(),
    type: z.enum(["dataset", "file"]).default("dataset"),
    source: z.string().optional(),
    source_live: z.string().optional(),
    source_ref: SourceRefSchema.optional(),
    taxonomies: z.array(z.string()).default([]), // vocabulary slugs — validated against `taxonomies` at ConfigSchema level
    writable: z.boolean().optional(), // opt-in to write path; verb support is structural
    // Per-document ACLs. Off unless a collection asks for them, because turning them on costs a
    // join on every read of the collection and a document with no ACL row is readable by anyone
    // the grant covers — so a project that never restricts an individual document pays nothing.
    //
    // The rule, once on: a document with no ACL is readable by anyone the grant covers; a document
    // WITH an ACL is readable only by the principals listed on it. See docs/architecture.md.
    acl: z.boolean().default(false),
    fields: z.record(z.string(), FieldSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
    const FIELD_NAME = /^[a-z_][a-z0-9_]*$/i;
    for (const name of Object.keys(c.fields)) {
      if (!FIELD_NAME.test(name))
        ctx.addIssue({
          code: "custom",
          message: `field name "${name}" invalid (must match [a-z_][a-z0-9_]*)`,
        });
      // `_acl` is the view's ACL column. A field of that name would collide with it, and the
      // collision would arrive as a duplicate-column error from `create view`, a long way from
      // the line that caused it — and on a collection with `acl: false` it would quietly become
      // a grantable field that the ACL evaluator then reads as a policy.
      if (name === ACL_COLUMN)
        ctx.addIssue({
          code: "custom",
          message: `field name "${ACL_COLUMN}" is reserved — it is the per-document ACL column`,
        });
    }

    // Validate each bound taxonomy field
    for (const taxSlug of c.taxonomies) {
      const tf = c.fields[taxSlug];
      if (tf) {
        if (tf.type && tf.type !== "text" && !tf.type.startsWith("text"))
          ctx.addIssue({
            code: "custom",
            message: `taxonomy field "${taxSlug}" must be type text`,
          });
        if (tf.pk || tf.fk || tf.view_join)
          ctx.addIssue({
            code: "custom",
            message: `taxonomy field "${taxSlug}" may not set pk/fk/view_join`,
          });
      }
    }

    // Validate view_join fields: 'on' must reference a field with fk: <table>.id
    for (const [name, f] of Object.entries(c.fields)) {
      if (f.view_join) {
        const fkFieldName = f.view_join.on;
        const fkField = c.fields[fkFieldName];
        if (!fkField)
          ctx.addIssue({
            code: "custom",
            message: `field "${name}" view_join references unknown field "${fkFieldName}"`,
          });
        else if (!fkField.fk)
          ctx.addIssue({
            code: "custom",
            message: `field "${name}" view_join references field "${fkFieldName}" which does not have fk`,
          });
        else if (!fkField.fk.startsWith(`${f.view_join.table}.`))
          ctx.addIssue({
            code: "custom",
            message: `field "${name}" view_join references table "${f.view_join.table}" but field "${fkFieldName}" has fk: ${fkField.fk}`,
          });
      }
    }
    if (c.type === "file") {
      if (!c.source) ctx.addIssue({ code: "custom", message: "file collection requires `source`" });
      const allowedFileFieldNames = new Set(FILE_FIELDS as readonly string[]);
      const allowedMetadataFieldTypes = new Set<string>(FILE_METADATA_TYPES);
      for (const [k, f] of Object.entries(c.fields)) {
        if (allowedFileFieldNames.has(k)) continue; // fixed FILE_FIELDS are always allowed
        if (c.taxonomies.includes(k)) continue; // taxonomy fields are allowed
        // Extra metadata fields: must have a type from the allowed set
        if (!f.type || !allowedMetadataFieldTypes.has(f.type))
          ctx.addIssue({
            code: "custom",
            message: `file collection field "${k}" must have type text/date/timestamptz/numeric/int/boolean (or be a FILE_FIELD or bound taxonomy)`,
          });
        // Metadata fields cannot be pk/fk/view_join
        if (f.pk || f.fk || f.view_join)
          ctx.addIssue({
            code: "custom",
            message: `file metadata field "${k}" cannot have pk/fk/view_join`,
          });
      }
    } else {
      const taxonomySet = new Set(c.taxonomies);
      for (const [k, f] of Object.entries(c.fields))
        if (!f.type && !taxonomySet.has(k))
          ctx.addIssue({ code: "custom", message: `field "${k}" requires a type` });
    }

    // searchable only on dataset text fields
    for (const [name, f] of Object.entries(c.fields)) {
      if (!f.searchable) continue;
      if (c.type === "file")
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has searchable: true on a file collection; the {c}__documents.tsv column already exists, so it is redundant`,
        });
      if (f.type !== "text")
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has searchable: true but is not type text`,
        });
      // A searchable field generates a sibling "<name>_tsv" column. A declared field of that
      // name would collide with it at DDL time, which is a confusing failure a long way from
      // its cause — refuse it here instead.
      if (c.fields[`${name}_tsv`])
        ctx.addIssue({
          code: "custom",
          message: `field "${name}_tsv" collides with the generated search column for "${name}"`,
        });
    }

    // writable: true requires at least one writable field
    if (c.writable) {
      const hasWritable = Object.values(c.fields).some((f) => writePosture(f) === "allow");
      if (!hasWritable)
        ctx.addIssue({
          code: "custom",
          message: `collection has writable: true but no field with write:allow`,
        });
    }

    // Per-document ACLs. Each refusal here is a shape v1 has no answer for, refused while the
    // author is looking at the file rather than as a broken join at apply time.
    if (c.acl) {
      // A file collection's documents are chunks of a file, so an ACL would have to key on
      // `file_id` rather than a declared pk, add a second join to the file branch of viewDDL, and
      // settle what the indexer's write path does with one. Out of scope for v1 — see
      // docs/architecture.md, "Per-document ACLs".
      if (c.type === "file")
        ctx.addIssue({
          code: "custom",
          message: `acl: true is not supported on a file collection — an ACL is keyed on the declared primary key, and a file collection declares none`,
        });
      // An external collection's rows live in someone else's database. There is no local base
      // table to join an ACL against, and its view has no org_id column to carry the tenant half
      // of the join predicate.
      else if (c.source_ref)
        ctx.addIssue({
          code: "custom",
          message: `acl: true is not supported on a source_ref collection — warehousd does not own those rows`,
        });
      else if (!Object.values(c.fields).some((f) => f.pk))
        ctx.addIssue({
          code: "custom",
          message: `acl: true requires a field with pk: true — an ACL is keyed on document identity`,
        });
    }

    // view_join fields are structurally write-deny
    for (const [name, f] of Object.entries(c.fields)) {
      if (f.view_join) {
        const wp = writePosture(f);
        if (wp === "allow")
          ctx.addIssue({
            code: "custom",
            message: `field "${name}" has view_join and write: allow; view_join fields are always write-deny`,
          });
      }
    }

    // Connect-in-place. A collection either stores its rows in warehousd or reads them from
    // somewhere else; the two are different enough that mixing them is always a mistake.
    if (c.source_ref) {
      if (c.type === "file")
        ctx.addIssue({
          code: "custom",
          message:
            "`source_ref` is for dataset collections; a file collection is indexed from `source`",
        });
      if (c.source || c.source_live)
        ctx.addIssue({
          code: "custom",
          message:
            "a collection with `source_ref` reads from an external database, so it has no `source` directory",
        });
      if (c.writable)
        ctx.addIssue({
          code: "custom",
          message:
            "`writable: true` is not supported on a `source_ref` collection — warehousd reads external data, it does not write it",
        });
      for (const [name, f] of Object.entries(c.fields)) {
        // A join reaches a sibling table in the SAME schema. Resolving one across a foreign
        // table would silently pull the whole remote relation over the wire per row.
        if (f.view_join)
          ctx.addIssue({
            code: "custom",
            message: `field "${name}" has view_join on an external collection; joins are not resolved across a source_ref`,
          });
        if (f.searchable)
          ctx.addIssue({
            code: "custom",
            message: `field "${name}" has searchable: true on an external collection; the generated tsv column would have to live on the remote table`,
          });
      }
    } else {
      for (const [name, f] of Object.entries(c.fields))
        if (f.column)
          ctx.addIssue({
            code: "custom",
            message: `field "${name}" declares \`column\` but the collection has no \`source_ref\`; there is no remote column to rename`,
          });
    }

    // Masking. Every rule here closes a way for a mask to be decorative rather than real.
    for (const [name, f] of Object.entries(c.fields)) {
      const p = normalizePosture(f.posture);
      const masked = p.read === "mask";

      if (masked && !f.mask)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has read: mask but no \`mask\` — declare the transform`,
        });
      if (!masked && f.mask)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" declares \`mask\` but its read posture is "${p.read}"; a transform is only applied under read: mask`,
        });
      // Read from the RAW posture, not the normalized one. normalizePosture deliberately pins
      // unmask closed whenever read is not `mask`, so asking it here would make this branch
      // unreachable and the typo would parse silently as "no unmask" — which is safe, but
      // leaves the author believing they granted something they did not.
      const declared = f.posture;
      const declaredUnmask =
        typeof declared === "object" && declared !== null && "unmask" in declared
          ? (declared as { unmask?: unknown }).unmask
          : undefined;
      if (declaredUnmask === "allow" && !masked)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has unmask: allow but is not masked; there is nothing to unmask`,
        });
      if (!masked || !f.mask) continue;

      // A pk addresses a document. getDocument round-trips it and every filter compares against
      // it, so a masked one would return an id nothing can be looked up by.
      if (f.pk)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" is the primary key and cannot be masked — it is how a document is addressed`,
        });
      // The generated "<name>_tsv" column is built from the RAW column and is exposed by the
      // view, so a masked searchable field would be fully recoverable one search at a time.
      if (f.searchable)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" cannot be both searchable and masked — the generated ${name}_tsv column indexes the raw value`,
        });
      if (c.type === "file" && (name === "content" || name === "path"))
        ctx.addIssue({
          code: "custom",
          message: `file field "${name}" cannot be masked (content is chunked and indexed; path addresses the file)`,
        });

      const allowed = MASK_TYPES[f.mask.transform];
      // `redact` and `hash` are absent from MASK_TYPES because they apply to any type.
      if (allowed && f.type && !allowed.includes(f.type))
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has mask transform "${f.mask.transform}", which needs type ${allowed.join(" or ")}, but is type ${f.type}`,
        });
    }
  })
  .transform((c) => {
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
    // A provider with no url names where a database that does not exist here is hosted. Under
    // `managed: true` the target provisions the database and its own module knows what it built,
    // so this key would decide nothing while reading as though it did.
    if (d.database.provider && !hasUrl)
      ctx.addIssue({
        code: "custom",
        message: "deploy.database.provider only applies alongside `url`",
      });
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

export const ConfigSchema = z
  .object({
    project: z.string(),
    // Seed the §9 demo personas on first boot. Off by default: a consuming project must opt in.
    demo: z.boolean().default(false),
    // The audit trail. On unless a project turns it off, and turning it off is for lower
    // environments: nothing is recorded — allows, refusals and imports alike — and every result's
    // auditId comes back null. Read it through `auditEnabled()` in config/load.ts rather than
    // directly; see the note there.
    audit: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    database: z
      .object({
        managed: z.boolean().optional(),
        url: z.string().optional(),
        // Host port for the CLI-managed Postgres. Default (server.port + 1) is applied in the CLI,
        // not here, because it depends on a sibling field.
        port: z.number().optional(),
      })
      .optional(),
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
