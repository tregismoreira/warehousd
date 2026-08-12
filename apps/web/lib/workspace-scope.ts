import type { Pool } from "pg";
import { listMemberships, memberRole } from "@warehousd/broker";

const PREFIX = "workspace:";

// The one place a token scope becomes a workspace id. Null = the token named none.
export function workspaceFromScopes(scopes: string[]): string | null {
  const s = scopes.find((x) => x.startsWith(PREFIX));
  return s ? s.slice(PREFIX.length) : null;
}

// The workspace this caller acts in, or null.
//
// Unlike env, absence has no safe default. `env-scope.ts` can fall back to `dev` because dev is
// the narrower answer; there is no narrower workspace. So:
//   - requested and a membership  → that workspace
//   - requested and NOT a membership → null (indistinguishable from "no such workspace")
//   - not requested, exactly one membership → that one
//   - not requested, more than one (or zero) → null. Refuse rather than pick; picking would mean
//     a credential silently reads a tenant its holder did not name.
export async function resolveWorkspace(
  pool: Pool,
  userId: string,
  requested: string | null,
): Promise<string | null> {
  if (requested !== null) {
    const role = await memberRole(pool, requested, userId);
    return role !== null ? requested : null;
  }
  const memberships = await listMemberships(pool, userId);
  const [only, ...rest] = memberships;
  if (!only || rest.length > 0) return null;
  return only.workspaceId;
}
