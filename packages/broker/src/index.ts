export * from "./types";
export { makeBroker } from "./broker";
// The runtime shapes behind types.ts. Adapters parse with these so a malformed body answers 400
// before it costs a grant lookup; the broker parses again regardless (see checkIntent).
export {
  QueryIntentSchema,
  DocSearchIntentSchema,
  GetDocumentIntentSchema,
  MutationIntentSchema,
  FilterSchema,
  AggregateSchema,
  FILTER_OPS,
  AGGREGATE_FNS,
  describeIntentError,
} from "./intents/schema";
export { createPools, onPoolError, type Pools, withOrg, writePool } from "./db/pools";
export {
  loadConfig,
  grantableFields,
  unmaskableFields,
  maskedFieldsFor,
  findCollection,
  envRefs,
  auditEnabled,
} from "./config/load";
export { maskExpr, UnsupportedMask, MASK_KEY_ENV } from "./sql/mask";
export {
  ExtractionFailed,
  type Embedder,
  type BinaryExtractor,
  type ExtractedText,
} from "./providers";
export { embedCollection, embedChunks, type EmbedProgress } from "./embedding/sync";
export { DEFAULT_EMBEDDING_DIMENSIONS } from "./apply/ddl";
export { EmbeddingSchema, type EmbeddingConfig } from "./config/schema";
export {
  ConfigSchema,
  SsoSchema,
  SsoProviderSchema,
  APP_ROLES,
  type AppRole,
  type SsoProviderConfig,
} from "./config/schema";
export type { WarehousdConfig } from "./config/schema";
export {
  fileMetadataFields,
  FILE_METADATA_TYPES,
  DeploySchema,
  normalizePosture,
  readPosture,
  writePosture,
} from "./config/schema";
export type {
  CollectionConfig,
  FileMetadataType,
  DeployConfig,
  MaskConfig,
  ReadPosture,
  NormalizedPosture,
} from "./config/schema";
export { unmaskPosture, isGrantable, READ_POSTURES, MaskSchema } from "./config/schema";
export { applyConfig } from "./apply/apply";
export { declaredTables, declaredPkField } from "./apply/ddl";
export type { DeclaredTable, DeclaredColumn } from "./apply/ddl";
export {
  planFromSchema,
  planFromConfigs,
  classifyCast,
  destructive,
  type SchemaChange,
  type ChangeKind,
} from "./apply/plan";
export { renderMigrationSql, nextMigrationFilename } from "./apply/migration-sql";
export {
  runProjectMigrations,
  readProjectMigrations,
  projectMigrationStatus,
  type ProjectMigration,
  type ProjectMigrationStatus,
} from "./db/project-migrations";
export { generateSynthetic } from "./synthetic/generate";
export { regenerateSynthetic } from "./synthetic/regenerate";
export { migrateApp, createAppSchema, DEFAULT_ORG_ID, migrateUserOrg } from "./db/migrate-app";
export { MIGRATIONS, type Migration } from "./db/migrations";
export { redact, redactString } from "./log/redact";
export * from "./grants/manage";
export {
  getClientPolicy,
  hasApprovedLiveGrant,
  upsertClientPolicy,
  setAllowedScopes,
  getDevClient,
  ensureDevClient,
  DEV_CLIENT_NAME,
} from "./oauth/client-policies";
export type { ClientPolicy } from "./oauth/client-policies";
export {
  resolveEnvScopes,
  resolveIssuedEnvScope,
  recomputeEnvScope,
  narrowPolicyToKeyEnv,
  pickEnvScope,
  type ClientPolicy as EnvScopeClientPolicy,
} from "./oauth/env-scope";
export * from "./db/bootstrap";
export {
  indexCollection,
  planUpload,
  uploadFile,
  deleteUploadedFile,
  readFileBlob,
  blobChecksum,
  UPLOAD_STATUSES,
  type UploadStatus,
  type PlanEntry,
  type PlanResult,
  type UploadOutcome,
  type UploadRefusal,
  type MetadataField,
} from "./indexing";
export { syncDatasetTerms, loadTaxonomyBindings, slugify, type TaxonomyBinding } from "./taxonomy";
export type { DocSearchIntent } from "./types";
export { listDocumentPaths } from "./documents/paths";
export {
  countDocuments,
  countDocumentsIn,
  countTermUsage,
  listFiles,
  type FileSummary,
  type Scope,
} from "./documents/inventory";
export {
  importCollection,
  IMPORT_MODES,
  type ImportMode,
  type ImportResult,
  type ImportCounts,
} from "./import/run";
export {
  insertRevision,
  currentRevision,
  demoteRevision,
  reviseDocument,
  SEED_REV_COLUMNS,
  SEED_REV_VALUES,
  type RevisionMeta,
  type RevisionOp,
  type RevisionStatus,
} from "./db/revisions";
export { validateImportRows, type ImportError } from "./import/validate";
export { parseImportPayload, parseCsv } from "./import/csv";
export * from "./credentials/keys";
export {
  createTrustedIssuer,
  listTrustedIssuers,
  getTrustedIssuer,
  type TrustedIssuer,
} from "./credentials/issuers";
