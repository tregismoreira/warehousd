import { PROVISIONABLE_DB_PROVIDER_IDS, type DbProviderId } from "@warehousd/broker";
import type { DbHost } from "./types";
import { supabase } from "./supabase";
import { neon } from "./neon";

/**
 * Every provider whose CLI warehousd can drive to create a database.
 *
 * A third host is one file and one line here — nothing else in the codebase may branch on a
 * provider id, the same rule `deploy/targets/index.ts` and `containers/runtimes/index.ts` state.
 *
 * `Partial` is load-bearing rather than lazy. Not every `DbProviderId` belongs here: `generic`
 * names no CLI at all, and `railway`'s database is created by the Railway *deploy target*, so a
 * host for it would be a second route to the same thing and a second way to end up with two.
 *
 * The two halves are held together at compile time in both directions. `satisfies` proves every
 * key is a real provider id; `assertHostsMatchProviders` below proves the set is exactly the one
 * the broker's `provisions` flags declare — which is what `DeploySchema` refuses `managed` +
 * `provider: generic` against. Without the second check a host could exist that the schema would
 * reject, or a flag could promise a host that was never written.
 */
export const dbHosts = {
  supabase,
  neon,
} satisfies Partial<Record<DbProviderId, DbHost>>;

export type DbHostId = keyof typeof dbHosts;

export function hostFor(id: DbProviderId): DbHost | undefined {
  return (dbHosts as Partial<Record<DbProviderId, DbHost>>)[id];
}

/** The hosts that can run a local dev stack — Supabase today, not Neon. */
export function localHosts(): DbHost[] {
  return Object.values(dbHosts).filter((host) => host.local !== undefined);
}

/**
 * The runtime half of the claim `satisfies` cannot make: that this registry and the broker's
 * `provisions` flags describe the same set. Exercised by `db-hosts.test.ts` rather than run at
 * import — a startup cost on every CLI invocation to catch a mistake only a commit can introduce
 * is the wrong trade.
 */
export function hostsMatchProviders(): boolean {
  const declared = [...PROVISIONABLE_DB_PROVIDER_IDS].sort();
  const implemented = Object.keys(dbHosts).sort();
  return JSON.stringify(declared) === JSON.stringify(implemented);
}

export type {
  DbHost,
  DbHostContext,
  DbHostLocal,
  DbHostPreflightInput,
  LocalContext,
  Provisioned,
  SavedDatabase,
} from "./types";
