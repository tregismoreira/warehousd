import type { Queryable } from "../queryable";

/**
 * One `{ id, ok, detail }` line, the same shape the CLI renders for every other pre-flight check
 * (`renderChecks` in packages/cli/src/ui/render.ts). Declared here rather than imported because
 * the broker is the trust boundary and imports nothing from the CLI — see AGENTS.md,
 * Non-negotiable 1. The two types are structurally identical on purpose, so a provider's checks
 * go straight into the CLI's array with no adapter.
 */
export type ProviderCheck = { id: string; ok: boolean; detail: string };

/**
 * Where a deployment's Postgres is hosted, as far as anything this codebase does differs.
 *
 * There is exactly one thing that genuinely differs and it is `roleUsername`: on Supabase's
 * Supavisor pooler the connecting username carries the tenant, so "the same database as role R"
 * is not spelled by swapping the username for R. Everything else here exists so a provider can
 * refuse a configuration that would fail later and further away.
 */
export type DbProvider = {
  id: string;
  /** Human name, for check details and docs links. */
  label: string;
  /** Does this url belong to me? Host-pattern match. `generic` is never asked — see detectProvider. */
  matches(url: URL): boolean;
  /**
   * Can warehousd create a database here, given the provider's own CLI?
   *
   * Declarative on purpose. The thing that actually shells out to `supabase projects create` is a
   * `DbHost` in `packages/cli/src/db/hosts` — the broker is the trust boundary and runs no child
   * processes (AGENTS.md, Non-negotiable 1). But `DeploySchema` has to be able to refuse
   * `managed: true` alongside `provider: generic` without importing the CLI, so the *fact* lives
   * here and the *capability* lives there. The CLI registry `satisfies` this set, which is what
   * stops the two drifting: a flag with no host, or a host with no flag, does not compile.
   */
  provisions?: boolean;
  /** How this provider spells "the same database, as role R". Default: the plain role name. */
  roleUsername(url: URL, role: string): string;
  /**
   * Provider-specific pre-flight, beyond the generic capability probe the CLI runs.
   *
   * `db` is null when the connection could not be made, and a provider must still be able to
   * answer — Supabase's refusal of the transaction pooler is exactly the case where connecting
   * may well have succeeded or failed for reasons that have nothing to do with the finding.
   *
   * The return type admits a plain array because the two findings that exist today are read off
   * the url and need no round trip; a provider that does need one returns the promise.
   */
  checks?(url: URL, db: Queryable | null): ProviderCheck[] | Promise<ProviderCheck[]>;
};
