import { z } from "zod";

export const FieldSchema = z.object({
  type: z.enum(["uuid", "text", "numeric", "int", "timestamptz", "date", "boolean", "json"]),
  posture: z.enum(["allow", "deny"]),
  pk: z.boolean().optional(),
  fk: z.string().optional(),            // "people.id"
  view_join: z.string().optional(),     // "departments.name"
  nullable: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type FieldConfig = z.infer<typeof FieldSchema>;

export const CollectionSchema = z.object({
  description: z.string(),
  fields: z.record(FieldSchema),
});

export const ConfigSchema = z.object({
  project: z.string(),
  database: z.object({ managed: z.boolean().optional(), url: z.string().optional() }).optional(),
  server: z.object({ port: z.number() }).default({ port: 8722 }),
  collections: z.record(CollectionSchema),
  synthetic: z.object({ rows_per_collection: z.record(z.number()).default({}) }).default({ rows_per_collection: {} }),
});
export type WarehousdConfig = z.infer<typeof ConfigSchema>;
