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
export { loadConfig, grantableFields, findCollection, envRefs } from "./config/load";
export type { WarehousdConfig } from "./config/schema";
export {
  fileMetadataFields,
  FILE_METADATA_TYPES,
  DeploySchema,
  normalizePosture,
  readPosture,
  writePosture,
} from "./config/schema";
export type { CollectionConfig, FileMetadataType, DeployConfig } from "./config/schema";
export { applyConfig } from "./apply/apply";
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
  pickEnvScope,
  type ClientPolicy as EnvScopeClientPolicy,
} from "./oauth/env-scope";
export * from "./db/bootstrap";
export { indexCollection } from "./indexing";
export { syncDatasetTerms, loadTaxonomyBindings, slugify, type TaxonomyBinding } from "./taxonomy";
export type { DocSearchIntent } from "./types";
export { listDocumentPaths } from "./documents/paths";
export { importCollection } from "./import/run";
export { validateImportRows, type ImportError } from "./import/validate";
export { parseImportPayload, parseCsv } from "./import/csv";
export * from "./credentials/keys";
export {
  createTrustedIssuer,
  listTrustedIssuers,
  getTrustedIssuer,
  type TrustedIssuer,
} from "./credentials/issuers";
