import { z } from "zod";

export const DOCUMENT_FIELDS = ["title", "content", "path", "owner", "updated_at"] as const;

// Column names a vocabulary slug may never take: the fixed document fields plus
// structural columns emitted by document DDL/views and reserved result keys.
export const TAXONOMY_RESERVED_SLUGS = new Set<string>([
  ...DOCUMENT_FIELDS, "id", "checksum", "chunk_id", "chunk_index", "document_id", "tsv", "_rank",
]);

export const TermSchema = z.object({ label: z.string() });
export const VocabularySchema = z.object({ label: z.string(), terms: z.record(TermSchema) });
export type VocabularyConfig = z.infer<typeof VocabularySchema>;

export const FieldSchema = z.object({
  type: z.enum(["uuid", "text", "numeric", "int", "timestamptz", "date", "boolean", "json"]).optional(),
  posture: z.enum(["allow", "deny"]),
  pk: z.boolean().optional(),
  fk: z.string().optional(),            // "people.id"
  view_join: z.string().optional(),     // "departments.name"
  nullable: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type FieldConfig = z.infer<typeof FieldSchema>;

export const DOCUMENT_FIELD_TYPES: Record<(typeof DOCUMENT_FIELDS)[number], FieldConfig["type"]> = {
  title: "text", content: "text", path: "text", owner: "text", updated_at: "timestamptz",
};

export const CollectionSchema = z.object({
  description: z.string(),
  type: z.enum(["structured", "document"]).default("structured"),
  source: z.string().optional(),
  source_live: z.string().optional(),
  taxonomy: z.string().optional(),      // vocabulary slug — validated against `taxonomies` at ConfigSchema level
  fields: z.record(FieldSchema),
}).superRefine((c, ctx) => {
  const tf = c.taxonomy ? c.fields[c.taxonomy] : undefined;
  if (tf) {
    if (tf.type && tf.type !== "text")
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `taxonomy field "${c.taxonomy}" must be type text` });
    if (tf.pk || tf.fk || tf.view_join)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `taxonomy field "${c.taxonomy}" may not set pk/fk/view_join` });
  }
  if (c.type === "document") {
    if (!c.source) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "document collection requires `source`" });
    for (const k of Object.keys(c.fields))
      if (!(DOCUMENT_FIELDS as readonly string[]).includes(k) && k !== c.taxonomy)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `document field "${k}" not in fixed set ${DOCUMENT_FIELDS.join(",")}` });
  } else {
    for (const [k, f] of Object.entries(c.fields))
      if (!f.type && k !== c.taxonomy)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${k}" requires a type` });
  }
}).transform((c) => {
  const fields = { ...c.fields };
  // Bound term field: auto-add as text/allow when omitted; fill type text when untyped.
  if (c.taxonomy) {
    const tf = fields[c.taxonomy];
    fields[c.taxonomy] = tf ? { ...tf, type: tf.type ?? "text" } : { posture: "allow", type: "text" };
  }
  if (c.type !== "document") return { ...c, fields };
  const filled = Object.fromEntries(Object.entries(fields).map(([k, f]) =>
    [k, { ...f, type: f.type ?? DOCUMENT_FIELD_TYPES[k as (typeof DOCUMENT_FIELDS)[number]] ?? "text" }]));
  return { ...c, fields: filled };
});

export const ConfigSchema = z.object({
  project: z.string(),
  database: z.object({ managed: z.boolean().optional(), url: z.string().optional() }).optional(),
  server: z.object({ port: z.number() }).default({ port: 8722 }),
  taxonomies: z.record(VocabularySchema).default({}).superRefine((tx, ctx) => {
    for (const [slug, v] of Object.entries(tx)) {
      if (!/^[a-z][a-z0-9_]*$/.test(slug) || slug.includes("__") || TAXONOMY_RESERVED_SLUGS.has(slug))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `vocabulary slug "${slug}" invalid (must match [a-z][a-z0-9_]*, no "__", not a reserved column name)` });
      for (const t of Object.keys(v.terms))
        if (!/^[a-z0-9][a-z0-9-]*$/.test(t))
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `term slug "${t}" in vocabulary "${slug}" must be lowercase kebab-case` });
    }
  }),
  collections: z.record(CollectionSchema).superRefine((cols, ctx) => {
    for (const name of Object.keys(cols))
      if (name.includes("__"))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `collection name "${name}" must not contain "__" (reserved)` });
  }),
  synthetic: z.object({ rows_per_collection: z.record(z.number()).default({}) }).default({ rows_per_collection: {} }),
}).superRefine((cfg, ctx) => {
  for (const [name, c] of Object.entries(cfg.collections))
    if (c.taxonomy && !cfg.taxonomies[c.taxonomy])
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `collection "${name}" binds unknown vocabulary "${c.taxonomy}"` });
});
export type WarehousdConfig = z.infer<typeof ConfigSchema>;
