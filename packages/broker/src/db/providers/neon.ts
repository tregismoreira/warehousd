import type { DbProvider, ProviderCheck } from "./types";

/**
 * Plain role names: Neon puts the project in the hostname, not the username.
 *
 * Roles created through SQL are not members of `neon_superuser`, which is fine — the four
 * warehousd roles only ever need the grants `ensureSchemasAndRoles` hands them, and none of those
 * requires ownership of anything.
 */
function checks(url: URL): ProviderCheck[] {
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode === "require" || sslmode === "verify-full" || sslmode === "verify-ca") {
    return [{ id: "db-provider", ok: true, detail: `Neon, sslmode=${sslmode}` }];
  }
  // Advisory rather than a refusal: Neon's proxy negotiates TLS regardless, so this is about the
  // client refusing a downgrade rather than about the connection being in the clear today.
  return [
    {
      id: "db-provider",
      ok: true,
      detail:
        "Neon, but the url carries no `sslmode` — add `?sslmode=require` so the client refuses " +
        "an unencrypted connection rather than accepting whichever one it is offered",
    },
  ];
}

export const neon: DbProvider = {
  id: "neon",
  label: "Neon",
  matches: (url) => url.hostname.endsWith(".neon.tech"),
  roleUsername: (_url, role) => role,
  checks,
  provisions: true,
};
