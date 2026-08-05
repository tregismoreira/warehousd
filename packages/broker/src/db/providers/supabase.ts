import type { DbProvider, ProviderCheck } from "./types";

// Supavisor, Supabase's connection pooler, in transaction mode. Session mode and the direct
// connection both answer on 5432.
const TRANSACTION_POOLER_PORT = "6543";

/**
 * The reason this axis exists.
 *
 * Through Supavisor the connecting username carries the tenant — `postgres.<project_ref>` — because
 * one pooler fronts every project on the region and the username is how it knows which one. Swap
 * that for a bare `warehousd_dev` and the pooler has no project to route to, so the role
 * authenticates as nobody and every governed query fails at connect time.
 *
 * The ref is read off the incoming username rather than the host: the pooler host
 * (`aws-0-<region>.pooler.supabase.com`) does not carry it, and on the direct host
 * (`db.<ref>.supabase.co`) the username is a plain `postgres` and the plain role name is correct.
 * A username with no dot is therefore left alone, whichever host it arrived on.
 */
function roleUsername(url: URL, role: string): string {
  const user = decodeURIComponent(url.username);
  const dot = user.indexOf(".");
  if (dot === -1) return role;
  return `${role}.${user.slice(dot + 1)}`;
}

function checks(url: URL): ProviderCheck[] {
  if (url.port !== TRANSACTION_POOLER_PORT) {
    return [
      {
        id: "db-provider",
        ok: true,
        detail: `Supabase on port ${url.port || "5432"} — session pooler or direct, which accept connection startup parameters`,
      },
    ];
  }
  return [
    {
      id: "db-provider",
      ok: false,
      detail:
        `Supabase's transaction pooler (port ${TRANSACTION_POOLER_PORT}) does not honour connection ` +
        `startup parameters, and warehousd sets three of them: search_path for the auth schema, ` +
        `statement_timeout and idle_in_transaction_session_timeout for the query pools. Use the ` +
        `session pooler or the direct connection (port 5432). See docs/deploy-database.md.`,
    },
  ];
}

export const supabase: DbProvider = {
  id: "supabase",
  label: "Supabase",
  matches: (url) =>
    url.hostname.endsWith(".supabase.co") || url.hostname.endsWith(".pooler.supabase.com"),
  roleUsername,
  checks,
};
