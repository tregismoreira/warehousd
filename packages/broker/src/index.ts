export * from "./types";
export { makeBroker } from "./broker";
export type { AccessExplanation, ExplainResult, FieldExplanation } from "./verbs/explain";
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
// The one audit writer. Exported because the console's regen route records an operational event
// of its own, and it must reach the configured sink like everything else — see audit/decision.ts.
export {
  makeAuditWriter,
  auditDestination,
  type AuditDestination,
  type AuditWriter,
} from "./audit/decision";
export { maskExpr, UnsupportedMask, MASK_KEY_ENV } from "./sql/mask";
export { maskPreview, maskSample, type MaskPreview } from "./sql/mask-preview";
export {
  ExtractionFailed,
  type Embedder,
  type BinaryExtractor,
  type ExtractedText,
} from "./providers";
export { embedCollection, embedChunks, type EmbedProgress } from "./embedding/sync";
export { DEFAULT_EMBEDDING_DIMENSIONS } from "./apply/ddl";
export { EmbeddingSchema, type EmbeddingConfig } from "./config/schema";
export { AuditSchema, type AuditConfig } from "./config/schema";
export {
  auditSinks,
  auditSink,
  AUDIT_SINK_IDS,
  DEFAULT_AUDIT_SINK,
  type AuditSink,
  type AuditSinkId,
  type AuditSinkOptions,
} from "./audit/sinks";
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
// The deploy target ids, for DeploySchema here and for the CLI's target registry there.
export { DEPLOY_TARGET_IDS, DEFAULT_DEPLOY_TARGET_ID, type DeployTargetId } from "./config/targets";
export { applyConfig, type ApplyProgress } from "./apply/apply";
export {
  collectionKinds,
  kindOf,
  COLLECTION_KIND_IDS,
  type CollectionKind,
  type CollectionKindId,
} from "./config/kinds";
// Per-document ACLs. The read/write verbs hang off the broker object (broker.ts); what is exported
// here is what an adapter needs around them — the manager identity type, group membership, and the
// principal spelling that both sides have to agree on.
export {
  listUserGroups,
  setUserGroups,
  listGroups,
  listGroupMembers,
  type AclManager,
  type DocumentAcl,
  type GroupSource,
  type GetAclResult,
  type SetAclResult,
  type AclRefusalReason,
} from "./acl/manage";
export {
  userPrincipal,
  groupPrincipal,
  isPrincipal,
  loadPrincipals,
  USER_PREFIX,
  GROUP_PREFIX,
} from "./acl/principals";
export { ACL_COLUMN, ACL_TABLE } from "./config/schema";
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
export { generateSynthetic, type SyntheticProgress } from "./synthetic/generate";
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
  setCanManageAcl,
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
export { UNQUALIFIED_EXTENSIONS } from "./db/search-path";
export {
  dbProviders,
  detectProvider,
  resolveProvider,
  DB_PROVIDER_IDS,
  type DbProvider,
  type DbProviderId,
  type ProviderCheck,
} from "./db/providers";
export {
  indexCollection,
  type IndexProgress,
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
  type ImportProgress,
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
export {
  validateImportRows,
  summarizeImportErrors,
  type ImportError,
  type ImportErrorGroup,
  type ImportErrorScope,
  type ImportErrorSummary,
} from "./import/validate";
export {
  reportImportSummary,
  formatImportReport,
  importErrorLabel,
  IMPORT_ERROR_LABELS,
  type ImportReport,
  type ImportReportLine,
} from "./import/report";
export {
  parseImport,
  parseImportPayload,
  parseCsv,
  IMPORT_FORMATS,
  type ImportFormat,
  type ImportPayload,
} from "./import/csv";
export {
  inferCollection,
  inferMapping,
  inferPosture,
  fieldNameFor,
  renderCollectionYaml,
  renderMappingYaml,
  SENSITIVE_HEADERS,
  type InferredCollection,
  type InferredField,
  type InferredMapping,
  type InferredPosture,
} from "./import/infer";
export {
  selectSheet,
  rowsFromSheet,
  SheetSelectionError,
  type SheetGrid,
  type SheetReader,
  type SheetOptions,
} from "./import/sheet";
export * from "./credentials/keys";
export {
  createTrustedIssuer,
  listTrustedIssuers,
  getTrustedIssuer,
  type TrustedIssuer,
} from "./credentials/issuers";
