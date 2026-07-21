import { z } from "zod";

export const DOCUMENT_FIELDS = ["title", "content", "path", "owner", "updated_at"] as const;

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
  fields: z.record(FieldSchema),
}).superRefine((c, ctx) => {
  if (c.type === "document") {
    if (!c.source) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "document collection requires `source`" });
    for (const k of Object.keys(c.fields))
      if (!(DOCUMENT_FIELDS as readonly string[]).includes(k))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `document field "${k}" not in fixed set ${DOCUMENT_FIELDS.join(",")}` });
  } else {
    for (const [k, f] of Object.entries(c.fields))
      if (!f.type) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field "${k}" requires a type` });
  }
}).transform((c) => {
  if (c.type !== "document") return c;
  const fields = Object.fromEntries(Object.entries(c.fields).map(([k, f]) =>
    [k, { ...f, type: f.type ?? DOCUMENT_FIELD_TYPES[k as (typeof DOCUMENT_FIELDS)[number]] }]));
  return { ...c, fields };
});

export const ConfigSchema = z.object({
  project: z.string(),
  database: z.object({ managed: z.boolean().optional(), url: z.string().optional() }).optional(),
  server: z.object({ port: z.number() }).default({ port: 8722 }),
  collections: z.record(CollectionSchema).superRefine((cols, ctx) => {
    for (const name of Object.keys(cols))
      if (name.includes("__"))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `collection name "${name}" must not contain "__" (reserved)` });
  }),
  synthetic: z.object({ rows_per_collection: z.record(z.number()).default({}) }).default({ rows_per_collection: {} }),
});
export type WarehousdConfig = z.infer<typeof ConfigSchema>;
