import { m0001Init } from "./0001-init";

export type Migration = { version: string; sql: string };

// Ordered, append-only. A static array rather than a directory scan, so Next.js file tracing and
// tsc output can never disagree with the runtime about which migrations exist — a scan that finds
// nothing inside a bundle looks exactly like a database that is already up to date.
//
// NEVER reorder, renumber, or edit the sql of a migration that has shipped: the ledger records
// versions, not contents, so an edited migration is silently skipped on every database that
// already ran it. Add a new one.
export const MIGRATIONS: readonly Migration[] = [m0001Init];
