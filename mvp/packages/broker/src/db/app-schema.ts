import { pgSchema, text, uuid, timestamp, jsonb } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export const collections = app.table("collections", {
  name: text("name").primaryKey(),
  description: text("description"),
  config: jsonb("config"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const grants = app.table("grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  collection: text("collection").notNull(),
  purposeLabel: text("purpose_label"),
  purposeDetail: text("purpose_detail"),
  allowedFields: text("allowed_fields").array(),
  env: text("env").notNull(),               // check ('dev','live') added in DDL
  status: text("status").notNull(),         // pending|approved|denied|revoked
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: text("decided_by"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  documentFilter: jsonb("document_filter"),
});

export const auditEvents = app.table("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).defaultNow(),
  userId: text("user_id"),
  env: text("env"),
  collection: text("collection"),
  intent: jsonb("intent"),
  fieldsReturned: text("fields_returned").array(),
  grantId: uuid("grant_id"),
  outcome: text("outcome"),                 // 'allowed' | 'refused'
  reason: text("reason"),
});

export const vocabularies = app.table("vocabularies", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
});

export const terms = app.table("terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  vocabularyId: uuid("vocabulary_id").notNull(),   // FK + unique(vocabulary_id, slug) enforced in DDL
  slug: text("slug").notNull(),
  label: text("label").notNull(),
  parentId: uuid("parent_id"),                     // reserved for hierarchy, unused in MVP
});
