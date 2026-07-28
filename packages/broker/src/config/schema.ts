import { z } from "zod";

export const FILE_FIELDS = ["title", "content", "path", "owner", "updated_at"] as const;

// Column names a vocabulary slug may never take: the fixed file fields plus
// structural columns emitted by document DDL/views and reserved result keys.
export const TAXONOMY_RESERVED_SLUGS = new Set<string>([
  ...FILE_FIELDS, "id", "checksum", "file_id", "document_seq", "tsv", "_rank",
]);

export const TermSchema = z.object({ label: z.string() });
export const VocabularySchema = z.object({ label: z.string(), terms: z.record(TermSchema) });
export type VocabularyConfig = z.infer<typeof VocabularySchema>;

const PostureSchema = z.union([
  z.enum(["allow", "deny"]),
  z.object({ read: z.enum(["allow", "deny"]), write: z.enum(["allow", "deny"]) }),
]);

export const FieldSchema = z.object({
  type: z.enum(["uuid", "text", "numeric", "int", "timestamptz", "date", "boolean", "json"]).optional(),
  posture: PostureSchema,
  pk: z.boolean().optional(),
  fk: z.string().optional(),            // "people.id"
  view_join: z.string().optional(),     // "departments.name"
  nullable: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  searchable: z.boolean().optional(),   // datasets only, text fields only
});
export type FieldConfig = z.infer<typeof FieldSchema>;

export const FILE_FIELD_TYPES: Record<(typeof FILE_FIELDS)[number], FieldConfig["type"]> = {
  title: "text", content: "text", path: "text", owner: "text", updated_at: "timestamptz",
};

export function normalizePosture(p: unknown): { read: "allow" | "deny"; write: "allow" | "deny" } {
  if (typeof p === "string") return { read: p === "allow" ? "allow" : "deny", write: "deny" };
  if (typeof p === "object" && p !== null && "read" in p && "write" in p) {
    const o = p as { read?: unknown; write?: unknown };
    return { read: o.read === "allow" ? "allow" : "deny", write: o.write === "allow" ? "allow" : "deny" };
  }
  return { read: "deny", write: "deny" };
}

export function readPosture(f: FieldConfig): "allow" | "deny" {
  const p = normalizePosture(f.posture);
  return p.read;
}

export function writePosture(f: FieldConfig): "allow" | "deny" {
  const p = normalizePosture(f.posture);
  return p.write;
}

export const CollectionSchema = z.object({
  description: z.string(),
  type: z.enum(["dataset", "file"]).default("dataset"),
  source: z.string().optional(),
  source_live: z.string().optional(),
  taxonomy: z.string().optional(),      // vocabulary slug — validated against `taxonomies` at ConfigSchema level
  writable: z.boolean().optional(),     // opt-in to write path; verb support is structural
  fields: z.record(FieldSchema),
}).superRefine((c, ctx) => {
  const FIELD_NAME = /^[a-z_][a-z0-9_]*$/i;
  for (const name of Object.keys(c.fields))
    if (!FIELD_NAME.test(name))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field name "${name}" invalid (must match [a-z_][a-z0-9_]*)` });

  const tf = c.taxonomy ? c.fields[c.taxonomy] : undefined;
  if (tf) {
    if (tf.type && tf.type !== "text")
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `taxonomy field "${c.taxonomy}" must be type text` });
    if (tf.pk || tf.fk || tf.view_join)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `taxonomy field "${c.taxonomy}" may not set pk/fk/view_join` });
  }
  if (c.type === "file") {
    if (!c.source) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "file collection requires `source`" });
    for (const k of Object.keys(c.fields))
      if (!(FILE_FIELDS as readonly string[]).includes(k) && k !== c.taxonomy)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${k}" not in fixed set ${FILE_FIELDS.join(",")}` });
  } else {
    for (const [k, f] of Object.entries(c.fields))
      if (!f.type && k !== c.taxonomy)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${k}" requires a type` });
  }

  // searchable only on dataset text fields
  for (const [name, f] of Object.entries(c.fields)) {
    if (!f.searchable) continue;
    if (c.type === "file")
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${name}" has searchable: true on a file collection; the {c}__documents.tsv column already exists, so it is redundant` });
    if (f.type !== "text")
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${name}" has searchable: true but is not type text` });
    // A searchable field generates a sibling "<name>_tsv" column. A declared field of that
    // name would collide with it at DDL time, which is a confusing failure a long way from
    // its cause — refuse it here instead.
    if (c.fields[`${name}_tsv`])
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${name}_tsv" collides with the generated search column for "${name}"` });
  }

  // writable: true requires at least one writable field
  if (c.writable) {
    const hasWritable = Object.values(c.fields).some((f) => writePosture(f) === "allow");
    if (!hasWritable)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `collection has writable: true but no field with write:allow` });
  }

  // view_join fields are structurally write-deny
  for (const [name, f] of Object.entries(c.fields)) {
    if (f.view_join) {
      const wp = writePosture(f);
      if (wp === "allow")
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${name}" has view_join and write: allow; view_join fields are always write-deny` });
    }
  }
}).transform((c) => {
  const fields = Object.fromEntries(Object.entries(c.fields).map(([k, f]) => [k, {
    ...f,
    // Normalize posture to canonical {read, write} form
    posture: normalizePosture(f.posture),
  }]));

  // Bound term field: auto-add as text/allow when omitted; fill type text when untyped.
  if (c.taxonomy) {
    const tf = fields[c.taxonomy];
    fields[c.taxonomy] = tf ? {
      ...tf, type: tf.type ?? "text",
      posture: tf.posture ?? { read: "allow", write: "deny" },
    } : { posture: { read: "allow", write: "deny" }, type: "text" };
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
  synthetic: z.object({ documents_per_collection: z.record(z.number()).default({}) }).default({ documents_per_collection: {} }),
}).superRefine((cfg, ctx) => {
  for (const [name, c] of Object.entries(cfg.collections))
    if (c.taxonomy && !cfg.taxonomies[c.taxonomy])
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `collection "${name}" binds unknown vocabulary "${c.taxonomy}"` });
});
export type WarehousdConfig = z.infer<typeof ConfigSchema>;
