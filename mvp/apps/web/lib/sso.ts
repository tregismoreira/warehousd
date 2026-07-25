import { sso } from "@better-auth/sso";
import type { Pool } from "pg";

// Origins allowed as OIDC issuers/discovery hosts. Better Auth's discovery rejects
// loopback and RFC-1918 hosts outright (validateDiscoveryUrl -> discovery_private_host);
// a local test IdP or an on-prem corporate IdP must be listed here explicitly.
export function trustedOrigins(): string[] {
  return (process.env.WAREHOUSD_TRUSTED_ORIGINS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

export function ssoPlugin(app: Pool) {
  return sso({
    // SPECS §6 item 3 — JIT: the first SSO login lands as `member`; an admin promotes
    // in the UI. Runs on registration only (isRegister), so an existing admin who later
    // links an SSO account is never demoted.
    provisionUser: async ({ user }) => {
      await app.query(`update app."user" set role = 'member' where id = $1`, [user.id]);
    },
  });
}
