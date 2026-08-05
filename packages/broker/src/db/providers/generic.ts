import type { DbProvider } from "./types";

/**
 * The fallback, and the definition of "no provider-specific behaviour": swap the username for the
 * role name, exactly what dataRoleUrl did before this registry existed. An unrecognised host is
 * therefore never worse off than it was.
 */
export const generic: DbProvider = {
  id: "generic",
  label: "Generic Postgres",
  matches: () => true,
  roleUsername: (_url, role) => role,
};
