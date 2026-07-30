import { pgSchema, text, uuid, timestamp, jsonb, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const app = pgSchema("app");

export const collections = app.table("collections", {
  name: text("name").primaryKey(),
  description: text("description"),
  config: jsonb("config"),
  orgId: text("org_id").notNull().default("default"), // config-defined, global; always 'default' in v1
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const grants = app.table("grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  collection: text("collection").notNull(),
  purposeLabel: text("purpose_label"),
  purposeDetail: text("purpose_detail"),
  allowedFields: text("allowed_fields").array(),
  orgId: text("org_id").notNull().default("default"),
  env: text("env").notNull(), // check ('dev','live') added in DDL
  status: text("status").notNull(), // pending|approved|denied|revoked
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
  orgId: text("org_id").notNull().default("default"),
  intent: jsonb("intent"),
  fieldsReturned: text("fields_returned").array(),
  grantId: uuid("grant_id"),
  outcome: text("outcome"), // 'allowed' | 'refused'
  reason: text("reason"),
  via: text("via"), // session | oauth | api_key:<id>
});

export const vocabularies = app.table("vocabularies", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
});

export const terms = app.table("terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  vocabularyId: uuid("vocabulary_id").notNull(), // FK + unique(vocabulary_id, env, slug) enforced in DDL
  env: text("env").notNull().default("all"), // check ('all','dev','live'); 'all' for YAML, env-specific for dataset-sourced
  slug: text("slug").notNull(),
  label: text("label").notNull(),
  parentId: uuid("parent_id"), // reserved for hierarchy, unused in MVP
});

export const clientPolicies = app.table("client_policies", {
  clientId: text("client_id").primaryKey(),
  displayName: text("display_name"),
  orgId: text("org_id").notNull().default("default"),
  allowedScopes: text("allowed_scopes")
    .array()
    .notNull()
    .default(sql`'{env:dev}'`),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  promotedBy: text("promoted_by"),
  allowedCollections: text("allowed_collections").array(), // null = no ceiling
  mode: text("mode").notNull().default("delegated"), // delegated | headless
  robotUserId: text("robot_user_id"), // headless only
  trustedIssuerId: uuid("trusted_issuer_id"), // delegated only
});

export const clientSecrets = app.table("client_secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull(), // FK enforced in DDL
  orgId: text("org_id").notNull(), // FK enforced in DDL
  prefix: text("prefix").notNull(),
  secretHash: text("secret_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const trustedIssuers = app.table("trusted_issuers", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(), // FK enforced in DDL
  issuer: text("issuer").notNull(),
  jwksUri: text("jwks_uri").notNull(),
  audience: text("audience").notNull(),
  subjectClaim: text("subject_claim").notNull().default("sub"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const changeLog = app.table("change_log", {
  seq: bigint("seq", { mode: "number" }).primaryKey(), // bigserial in DDL
  orgId: text("org_id").notNull(), // FK enforced in DDL
  env: text("env").notNull(), // check (env in ('dev','live'))
  collection: text("collection").notNull(),
  documentId: text("document_id").notNull(),
  rev: uuid("rev").notNull(),
  op: text("op").notNull(), // create, update, delete, or proposal
  status: text("status").notNull(), // approved, pending, rejected
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  by: text("by").notNull(),
});
