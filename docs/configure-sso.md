# Configure SSO (admin runbook)

Register an identity provider so members sign in with their company account
instead of a local warehousd password. Requires an `admin` account.

This runbook covers OIDC (generic — Okta, Entra ID, Google Workspace, Keycloak,
etc.) and SAML. Both are driven through the same admin API; the login page
picks the right client-side flow automatically based on the provider's `type`.

> ## ⚠️ Screenshots pending — outstanding human work
>
> The **server-side** flows here are covered by automated tests, including a real
> Keycloak OIDC **and** SAML round trip (`mvp/apps/web/test/sso-keycloak.integration.test.ts`,
> run via `pnpm test:e2e`): provider registration, the admin-only gate, JIT
> provisioning, and the local-login kill switch.
>
> **Step 3 is the exception.** The login page (`mvp/apps/web/app/login/page.tsx`)
> has **no automated test coverage at all** — no component or browser test
> exercises the SSO-first rendering, the collapsed local-login disclosure, the
> "No login method is configured" state, the `returnTo` OAuth-continuation
> redirect, or the SAML `providerType` branch. Only the `/api/sso/status`
> endpoint it reads is tested. Verifying step 3 by eye is therefore the *only*
> check on that code today.
>
> - [ ] Capture the 3 screenshots marked `*(Screenshot: …)*` below, save them
>       under `docs/img/`, and replace each placeholder with a markdown image link.
> - [ ] While you're there, sanity-check the admin UX by hand: register a
>       provider as `ana` (admin), confirm the same call returns `403` as `mia`
>       (member), and confirm `/login` visibly flips to SSO-first afterwards.
> - [ ] Delete this banner once all boxes are ticked.
>
> The companion runbook `docs/connect-claude.md` has a larger outstanding item —
> it has never been executed end-to-end at all.

---

## Prerequisite: `WAREHOUSD_TRUSTED_ORIGINS`

Better Auth's OIDC discovery **rejects loopback and private-network hosts by
default** (`discovery_private_host`). If your IdP is self-hosted, on a private
network, or running locally (e.g. a test Keycloak container), you must list
its origin in `WAREHOUSD_TRUSTED_ORIGINS` (comma-separated) **before**
registering it — otherwise registration fails immediately with that error.

```bash
WAREHOUSD_TRUSTED_ORIGINS=http://127.0.0.1:8780
```

Public, internet-reachable IdPs (Okta, Entra ID, Google Workspace) do not need
to be listed here.

---

## 1. Stand up an IdP (example: Keycloak, for local testing)

```bash
docker compose -f mvp/docker-compose.test.yml up -d keycloak
```

This starts Keycloak on `http://127.0.0.1:8780` with a pre-imported realm
(`warehousd-test`) containing an OIDC client and a SAML client — see
`mvp/test/keycloak/warehousd-realm.json`. For a production IdP, create the
client in your provider's admin console instead, with:

- Redirect URI (OIDC): `<your-app-origin>/api/auth/sso/callback/<providerId>`
- ACS URL (SAML): `<your-app-origin>/api/auth/sso/saml2/sp/acs/<providerId>`

`<providerId>` is whatever you choose when registering below (e.g. `okta-oidc`).

*(Screenshot: Keycloak admin console → Clients → create client)*

## 2. Register the IdP through the admin API

As `admin`, sign in to warehousd, then call:

```bash
curl -X POST http://localhost:8722/api/sso/providers \
  -H "Content-Type: application/json" \
  -H "Cookie: <admin session cookie>" \
  -d '{
    "providerId": "keycloak-oidc",
    "issuer": "http://127.0.0.1:8780/realms/warehousd-test",
    "domain": "meridian.demo",
    "oidcConfig": {
      "clientId": "warehousd-oidc",
      "clientSecret": "oidc-secret",
      "discoveryEndpoint": "http://127.0.0.1:8780/realms/warehousd-test/.well-known/openid-configuration"
    }
  }'
```

`domain` is the email domain new SSO users belong to — used for domain-based
IdP routing when multiple providers are configured.

Non-admins get `403`; this endpoint (and `GET`/`DELETE` on the same resource)
is admin-only regardless of who registered the provider — any admin can list,
inspect, or delete a provider another admin created.

*(Screenshot: admin console → SSO providers → "New provider" form)*

### SAML variant

```bash
curl -X POST http://localhost:8722/api/sso/providers \
  -H "Content-Type: application/json" \
  -H "Cookie: <admin session cookie>" \
  -d '{
    "providerId": "keycloak-saml",
    "issuer": "http://127.0.0.1:8780/realms/warehousd-test",
    "domain": "meridian.demo",
    "samlConfig": {
      "entryPoint": "http://127.0.0.1:8780/realms/warehousd-test/protocol/saml",
      "cert": "<IdP signing certificate, PEM, no headers/footers>",
      "callbackUrl": "http://localhost:8722/api/auth/sso/saml2/sp/acs/keycloak-saml",
      "spMetadata": { "entityID": "warehousd-sp" },
      "authnRequestsSigned": false,
      "wantAssertionsSigned": true
    }
  }'
```

`spMetadata` is required (unlike most of `samlConfig`) — at minimum pass
`{ entityID: "<your SP entity id>" }`, matching what you configured as the
client ID on the IdP side. Get the IdP's signing certificate from its SAML
descriptor (for Keycloak: `GET <issuer>/protocol/saml/descriptor`, extract the
`<ds:X509Certificate>` value) — do not hardcode a certificate you copied once;
fetch it fresh when rotating.

Leave `authnRequestsSigned: false` unless you also configure an SP private
key — warehousd does not require signed authn requests. Keep
`wantAssertionsSigned: true`; do not disable IdP-side assertion signing to
work around validation errors — fix the underlying signing/cert mismatch
instead.

## 3. Confirm the login page flips to SSO-first

Visit `http://localhost:8722/login`. With ≥1 provider registered, the page
shows a primary **"Sign in with your company account"** button; if local
login is still enabled, it collapses to a secondary "Use a local account"
disclosure below it.

*(Screenshot: login page, SSO button primary, local login collapsed)*

## 4. First SSO login lands as `member`

Sign in through the button. The IdP handles authentication; warehousd never
sees a password. On first login, a new `member`-role user is
just-in-time-provisioned with the IdP's email. Existing accounts that later
link an SSO identity (e.g. an `admin` who signs in via SSO for the first time)
are **not** demoted — provisioning only sets the role on brand-new accounts.

## 5. Promote the new member

As `admin`, promote the newly-provisioned member the same way you would any
other user (Admin → Clients/users role management, Phase 5 UI; or directly
via the existing role-management API).

## 6. Local login kill switch (optional)

To force every sign-in through SSO, set:

```bash
WAREHOUSD_DISABLE_LOCAL_LOGIN=true
```

and restart. With this set and no SSO provider configured, the login page
shows "No login method is configured" instead — always register at least one
provider before enabling the kill switch.

---

See [connect-claude.md](./connect-claude.md) for the end-to-end runbook of
connecting Claude's MCP connector once SSO is configured — the `/mcp/authorize`
step delegates to whichever IdP you registered here, the same way local login
used to.
