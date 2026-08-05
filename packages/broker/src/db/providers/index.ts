import type { DbProvider } from "./types";
import { supabase } from "./supabase";
import { neon } from "./neon";
import { railway } from "./railway";
import { generic } from "./generic";

/**
 * Every database provider warehousd knows anything specific about.
 *
 * A fourth provider is one file and one line here — nothing else in the codebase may branch on a
 * provider id. The union is `keyof typeof`, not a hand-written list, so an entry cannot be added
 * to one and forgotten in the other.
 */
export const dbProviders = {
  supabase,
  neon,
  railway,
  generic,
} satisfies Record<string, DbProvider>;

export type DbProviderId = keyof typeof dbProviders;

/** The zod enum's tuple. `z.enum` needs at least one member, which `Object.keys` cannot prove. */
export const DB_PROVIDER_IDS = Object.keys(dbProviders) as [DbProviderId, ...DbProviderId[]];

/**
 * Which provider hosts this url. Never throws: an unparseable connection string is `generic`,
 * which is byte-for-byte the behaviour every url had before this registry existed.
 *
 * `generic.matches` returns true for everything, so it is excluded from the scan rather than
 * relied upon to come last — key order in an object literal is a fragile thing to make correctness
 * depend on.
 */
export function detectProvider(url: string): DbProvider {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return generic;
  }
  for (const provider of Object.values(dbProviders)) {
    if (provider === generic) continue;
    if (provider.matches(parsed)) return provider;
  }
  return generic;
}

/** The provider named in config, or the one the url's host implies. */
export function resolveProvider(url: string, id?: DbProviderId): DbProvider {
  return id ? dbProviders[id] : detectProvider(url);
}

export type { DbProvider, ProviderCheck } from "./types";
