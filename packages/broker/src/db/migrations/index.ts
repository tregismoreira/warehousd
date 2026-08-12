import { m0001Init } from "./0001-init";
import { m0002LoginAttempts } from "./0002-login-attempts";
import { m0003LoginAttemptsSweep } from "./0003-login-attempts-sweep";
import { m0004CollectionMigrations } from "./0004-collection-migrations";
import { m0005GrantUnmaskedFields } from "./0005-grant-unmasked-fields";
import { m0006DocumentAcl } from "./0006-document-acl";
import { m0007GrantPrincipal } from "./0007-grant-principal";
import { m0008RenameOrgToWorkspace } from "./0008-rename-org-to-workspace";
import { m0009WorkspaceMembership } from "./0009-workspace-membership";
import { m0010TermsWorkspace } from "./0010-terms-workspace";
import { m0011PlatformKeys } from "./0011-platform-keys";
import { m0012ControlPlaneRls } from "./0012-control-plane-rls";

export type Migration = { version: string; sql: string };

// Ordered, append-only. A static array rather than a directory scan, so Next.js file tracing and
// tsc output can never disagree with the runtime about which migrations exist — a scan that finds
// nothing inside a bundle looks exactly like a database that is already up to date.
//
// NEVER reorder, renumber, or edit the sql of a migration that has shipped: the ledger records
// versions, not contents, so an edited migration is silently skipped on every database that
// already ran it. Add a new one.
export const MIGRATIONS: readonly Migration[] = [
  m0001Init,
  m0002LoginAttempts,
  m0003LoginAttemptsSweep,
  m0004CollectionMigrations,
  m0005GrantUnmaskedFields,
  m0006DocumentAcl,
  m0007GrantPrincipal,
  m0008RenameOrgToWorkspace,
  m0009WorkspaceMembership,
  m0010TermsWorkspace,
  m0011PlatformKeys,
  m0012ControlPlaneRls,
];
