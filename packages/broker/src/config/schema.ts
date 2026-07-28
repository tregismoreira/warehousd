import { z } from "zod";

export const FILE_FIELDS = ["title", "content", "path", "owner", "updated_at"] as const;

// Column names a vocabulary slug may never take: the fixed file fields plus
// structural columns emitted by document DDL/views and reserved result keys.
export const TAXONOMY_RESERVED_SLUGS = new Set<string>([
  ...FILE_FIELDS, "id", "checksum", "file_id", "document_seq", "tsv", "_rank",
]);

export const TermSchema = z.object({ label: z.string() });
export const VocabularySchema = z.object({
  label: z.string(),
  multiple: z.boolean().default(false),
  terms: z.record(TermSchema).optional(),
  source: z.object({
    collection: z.string(),
    slug: z.string(),
    label: z.string(),
  }).optional(),
}).superRefine((v, ctx) => {
  const hasTerms = !!v.terms;
  const hasSource = !!v.source;
  if (!hasTerms && !hasSource)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `vocabulary must have either "terms" (YAML) or "source" (dataset), not both` });
  if (hasTerms && hasSource)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `vocabulary must have either "terms" (YAML) or "source" (dataset), not both` });
});
export type VocabularyConfig = z.infer<typeof VocabularySchema>;

// Every part lands in a generated SQL identifier, so each is constrained to the same
// identifier shape field names use. Nothing here may reach SQL unvalidated.
const IDENT = /^[a-z_][a-z0-9_]*$/i;
export const ViewJoinSchema = z.object({
  table: z.string().regex(IDENT),
  column: z.string().regex(IDENT),
  on: z.string().regex(IDENT),
});
export type ViewJoinConfig = z.infer<typeof ViewJoinSchema>;

export const FieldSchema = z.object({
  type: z.enum(["uuid", "text", "numeric", "int", "timestamptz", "date", "boolean", "json"]).optional(),
  posture: z.enum(["allow", "deny"]),
  pk: z.boolean().optional(),
  fk: z.string().optional(),            // "people.id"
  view_join: ViewJoinSchema.optional(), // { table: "people", column: "full_name", on: "responsible_attorney_id" }
  nullable: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type FieldConfig = z.infer<typeof FieldSchema>;

// The types a file collection's extra (metadata) fields may take. `uuid` and `json` are
// excluded deliberately: frontmatter is hand-written prose, not a serialisation format.
export const FILE_METADATA_TYPES = ["text", "date", "timestamptz", "numeric", "int", "boolean"] as const;
export type FileMetadataType = (typeof FILE_METADATA_TYPES)[number];

export const FILE_FIELD_TYPES: Record<(typeof FILE_FIELDS)[number], FieldConfig["type"]> = {
  title: "text", content: "text", path: "text", owner: "text", updated_at: "timestamptz",
};

export const CollectionSchema = z.object({
  description: z.string(),
  type: z.enum(["dataset", "file"]).default("dataset"),
  source: z.string().optional(),
  source_live: z.string().optional(),
  taxonomies: z.array(z.string()).default([]),  // vocabulary slugs — validated against `taxonomies` at ConfigSchema level
  fields: z.record(FieldSchema),
}).superRefine((c, ctx) => {
  const FIELD_NAME = /^[a-z_][a-z0-9_]*$/i;
  for (const name of Object.keys(c.fields))
    if (!FIELD_NAME.test(name))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field name "${name}" invalid (must match [a-z_][a-z0-9_]*)` });

  // Validate each bound taxonomy field
  for (const taxSlug of c.taxonomies) {
    const tf = c.fields[taxSlug];
    if (tf) {
      if (tf.type && tf.type !== "text" && !tf.type.startsWith("text"))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `taxonomy field "${taxSlug}" must be type text` });
      if (tf.pk || tf.fk || tf.view_join)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `taxonomy field "${taxSlug}" may not set pk/fk/view_join` });
    }
  }

  // Validate view_join fields: 'on' must reference a field with fk: <table>.id
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.view_join) {
      const fkFieldName = f.view_join.on;
      const fkField = c.fields[fkFieldName];
      if (!fkField)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${name}" view_join references unknown field "${fkFieldName}"` });
      else if (!fkField.fk)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${name}" view_join references field "${fkFieldName}" which does not have fk` });
      else if (!fkField.fk.startsWith(`${f.view_join.table}.`))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${name}" view_join references table "${f.view_join.table}" but field "${fkFieldName}" has fk: ${fkField.fk}` });
    }
  }
  if (c.type === "file") {
    if (!c.source) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "file collection requires `source`" });
    const allowedFileFieldNames = new Set(FILE_FIELDS as readonly string[]);
    const allowedMetadataFieldTypes = new Set<string>(FILE_METADATA_TYPES);
    for (const [k, f] of Object.entries(c.fields)) {
      if (allowedFileFieldNames.has(k)) continue; // fixed FILE_FIELDS are always allowed
      if (c.taxonomies.includes(k)) continue; // taxonomy fields are allowed
      // Extra metadata fields: must have a type from the allowed set
      if (!f.type || !allowedMetadataFieldTypes.has(f.type))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `file collection field "${k}" must have type text/date/timestamptz/numeric/int/boolean (or be a FILE_FIELD or bound taxonomy)` });
      // Metadata fields cannot be pk/fk/view_join
      if (f.pk || f.fk || f.view_join)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `file metadata field "${k}" cannot have pk/fk/view_join` });
    }
  } else {
    const taxonomySet = new Set(c.taxonomies);
    for (const [k, f] of Object.entries(c.fields))
      if (!f.type && !taxonomySet.has(k))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${k}" requires a type` });
  }
}).transform((c) => {
  const fields = { ...c.fields };
  // Bound term fields: auto-add as text/allow when omitted; fill type text when untyped.
  for (const taxSlug of c.taxonomies) {
    const tf = fields[taxSlug];
    fields[taxSlug] = tf ? { ...tf, type: tf.type ?? "text" } : { posture: "allow", type: "text" };
  }
  if (c.type !== "file") return { ...c, fields };
  const filled = Object.fromEntries(Object.entries(fields).map(([k, f]) =>
    [k, { ...f, type: f.type ?? FILE_FIELD_TYPES[k as (typeof FILE_FIELDS)[number]] ?? "text" }]));
  return { ...c, fields: filled };
});

export const ConfigSchema = z.object({
  project: z.string(),
  // Seed the §9 demo personas on first boot. Off by default: a consuming project must opt in.
  demo: z.boolean().default(false),
  database: z.object({
    managed: z.boolean().optional(),
    url: z.string().optional(),
    // Host port for the CLI-managed Postgres. Default (server.port + 1) is applied in the CLI,
    // not here, because it depends on a sibling field.
    port: z.number().optional(),
  }).optional(),
  server: z.object({
    port: z.number(),
    // Override the published server image (CI/E2E point this at a locally built tag).
    image: z.string().optional(),
  }).default({ port: 8722 }),
  taxonomies: z.record(VocabularySchema).default({}).superRefine((tx, ctx) => {
    for (const [slug, v] of Object.entries(tx)) {
      if (!/^[a-z][a-z0-9_]*$/.test(slug) || slug.includes("__") || TAXONOMY_RESERVED_SLUGS.has(slug))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `vocabulary slug "${slug}" invalid (must match [a-z][a-z0-9_]*, no "__", not a reserved column name)` });
      if (v.terms) {
        for (const t of Object.keys(v.terms))
          if (!/^[a-z0-9][a-z0-9-]*$/.test(t))
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `term slug "${t}" in vocabulary "${slug}" must be lowercase kebab-case` });
      }
    }
  }),
  collections: z.record(CollectionSchema).superRefine((cols, ctx) => {
    for (const name of Object.keys(cols))
      if (name.includes("__"))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `collection name "${name}" must not contain "__" (reserved)` });
  }),
  synthetic: z.object({ documents_per_collection: z.record(z.number()).default({}) }).default({ documents_per_collection: {} }),
}).superRefine((cfg, ctx) => {
  for (const [name, c] of Object.entries(cfg.collections)) {
    // Validate that each bound taxonomy exists
    for (const taxSlug of c.taxonomies) {
      if (!cfg.taxonomies[taxSlug])
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `collection "${name}" binds unknown vocabulary "${taxSlug}"` });
    }
    // Validate dataset-sourced vocabularies reference valid collections and fields
    for (const taxSlug of c.taxonomies) {
      const vocab = cfg.taxonomies[taxSlug];
      if (vocab?.source) {
        const srcCol = cfg.collections[vocab.source.collection];
        if (!srcCol)
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `vocabulary "${taxSlug}" references unknown source collection "${vocab.source.collection}"` });
        else if (srcCol.type !== "dataset")
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `vocabulary "${taxSlug}" source collection "${vocab.source.collection}" must be type dataset` });
        else if (!srcCol.fields[vocab.source.slug] || !srcCol.fields[vocab.source.label])
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `vocabulary "${taxSlug}" source fields (slug: "${vocab.source.slug}", label: "${vocab.source.label}") not found in collection "${vocab.source.collection}"` });
      }
    }
  }
});
export type WarehousdConfig = z.infer<typeof ConfigSchema>;

export type CollectionConfig = WarehousdConfig["collections"][string];

// The typed extra fields a file collection declares beyond FILE_FIELDS and its bound
// vocabularies. Single source of truth: the DDL, the indexer and the CLI must agree exactly
// on this set, or a declared field ends up with a column and no value — or a value and no column.
export function fileMetadataFields(c: CollectionConfig): { field: string; type: FileMetadataType }[] {
  const fixed = new Set<string>([...FILE_FIELDS, ...(c.taxonomies ?? [])]);
  const allowed = new Set<string>(FILE_METADATA_TYPES);
  return Object.entries(c.fields)
    .filter(([k, f]) => !fixed.has(k) && !!f.type && allowed.has(f.type))
    .map(([k, f]) => ({ field: k, type: f.type as FileMetadataType }));
}
