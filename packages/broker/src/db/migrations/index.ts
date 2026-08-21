import { m0001Init } from "./0001-init";
import { m0002LoginAttempts } from "./0002-login-attempts";
import { m0003LoginAttemptsSweep } from "./0003-login-attempts-sweep";
import { m0004CollectionMigrations } from "./0004-collection-migrations";
import { m0005GrantUnmaskedFields } from "./0005-grant-unmasked-fields";
import { m0006DocumentAcl } from "./0006-document-acl";
import { m0007GrantPrincipal } from "./0007-grant-principal";
import { m0009WorkspaceMembership } from "./0009-workspace-membership";
import { m0010TermsWorkspace } from "./0010-terms-workspace";
import { m0011PlatformKeys } from "./0011-platform-keys";
import { m0012ControlPlaneRls } from "./0012-control-plane-rls";
import { m0013AuditBatchId } from "./0013-audit-batch-id";

export type Migration = { version: string; sql: string };

// Ordered, append-only. A static array rather than a directory scan, so Next.js file tracing and
// tsc output can never disagree with the runtime about which migrations exist — a scan that finds
// nothing inside a bundle looks exactly like a database that is already up to date.
//
// NEVER reorder, renumber, or edit the sql of a migration that has shipped: the ledger records
// versions, not contents, so an edited migration is silently skipped on every database that
// already ran it. Add a new one.
//
// 0008 is missing on purpose, not a gap to fill. It used to rename the org-named objects that
// 0001-0007 created to workspace names, because some database could already have bootstrapped
// under the old names. Nothing ever did, so that rename was collapsed back into 0001, 0006, 0007
// and 0011 (see 0001-init.ts's header) and 0008 was deleted rather than left as a no-op. Later
// migrations keep their version strings unrenumbered — 0009 follows 0007 here, and a fresh
// bootstrap just never sees a version in between.
export const MIGRATIONS: readonly Migration[] = [
  m0001Init,
  m0002LoginAttempts,
  m0003LoginAttemptsSweep,
  m0004CollectionMigrations,
  m0005GrantUnmaskedFields,
  m0006DocumentAcl,
  m0007GrantPrincipal,
  m0009WorkspaceMembership,
  m0010TermsWorkspace,
  m0011PlatformKeys,
  m0012ControlPlaneRls,
  m0013AuditBatchId,
];
