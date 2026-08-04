import { m0001Init } from "./0001-init";
import { m0002LoginAttempts } from "./0002-login-attempts";
import { m0003LoginAttemptsSweep } from "./0003-login-attempts-sweep";
import { m0004CollectionMigrations } from "./0004-collection-migrations";
import { m0005GrantUnmaskedFields } from "./0005-grant-unmasked-fields";

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
];
