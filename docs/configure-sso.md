# Configure SSO (admin runbook)

Register an identity provider so members sign in with their company account
instead of a local warehousd password. Requires an `admin` account.

This runbook covers OIDC (generic — Okta, Entra ID, Google Workspace, Keycloak,
etc.) and SAML. Both are driven through the same admin API; the login page
picks the right client-side flow automatically based on the provider's `type`.

---

## Prerequisite: `WAREHOUSD_TRUSTED_ORIGINS`

Better Auth refuses to fetch OIDC discovery from any origin not listed in
`WAREHOUSD_TRUSTED_ORIGINS` (comma-separated) — public IdPs included, not just
loopback and private-network hosts. Registering a provider whose issuer origin
is missing from the list fails immediately with a "not trusted by your trusted
origins configuration" error.

```bash
WAREHOUSD_TRUSTED_ORIGINS=https://your-tenant.us.auth0.com
```

`warehousd deploy` derives this for you: when `WAREHOUSD_TRUSTED_ORIGINS` is
not set in its environment, it ships the origin of `SSO_ISSUER` as the value.
Set it explicitly when you have more than one IdP, or a locally run one (e.g. a
test Keycloak container).

---

## 1. Create the client on your IdP

In your provider's admin console (Okta, Entra ID, Google Workspace, Keycloak),
create an application with:

- Redirect URI (OIDC): `<your-app-origin>/api/auth/sso/callback/<providerId>`
- ACS URL (SAML): `<your-app-origin>/api/auth/sso/saml2/sp/acs/<providerId>`

`<providerId>` is whatever you choose when registering below (e.g. `okta-oidc`).

> **Working in this repository?** `docker compose -f docker-compose.test.yml up -d keycloak`
> starts Keycloak on `http://127.0.0.1:8780` with a realm (`warehousd-test`)
> already containing an OIDC and a SAML client — see
> `test/keycloak/warehousd-realm.json`. That is the IdP the automated SSO suite
> uses, and the source of the example values below.

## 2. Register the IdP

Sign in as an `admin` and go to **Admin → SSO → Add provider**. The sheet has an
OIDC tab and a SAML tab; it derives the discovery endpoint and the ACS callback
URL for you.

The same thing scripted, against the admin API:

```bash
curl -X POST http://localhost:8722/api/sso/providers \
  -H "Content-Type: application/json" \
  -H "Cookie: <admin session cookie>" \
  -d '{
    "providerId": "keycloak-oidc",
    "issuer": "http://127.0.0.1:8780/realms/warehousd-test",
    "domain": "harbor.demo",
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

### SAML variant

```bash
curl -X POST http://localhost:8722/api/sso/providers \
  -H "Content-Type: application/json" \
  -H "Cookie: <admin session cookie>" \
  -d '{
    "providerId": "keycloak-saml",
    "issuer": "http://127.0.0.1:8780/realms/warehousd-test",
    "domain": "harbor.demo",
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

## 4. First SSO login lands as `member`

Sign in through the button. The IdP handles authentication; warehousd never
sees a password. On first login, a new `member`-role user is
just-in-time-provisioned with the IdP's email. Existing accounts that later
link an SSO identity (e.g. an `admin` who signs in via SSO for the first time)
are **not** demoted — provisioning only sets the role on brand-new accounts.

## 5. Map IdP groups to warehousd roles (optional)

Instead of promoting each new member by hand, declare a group→role map in
`warehousd.yml`, keyed by the `providerId` you registered above:

```yaml
sso:
  providers:
    keycloak-oidc:
      group_claim: groups        # the claim (OIDC) or attribute (SAML) carrying the groups
      groups:
        wh-admins: admin
        wh-managers: manager
      default_role: member       # what a user in none of these gets. Default: member
```

**The map lives in `warehousd.yml`, not in the provider registration.** A
provider is registered at runtime through the admin API; this file is
operator-controlled trusted input, and a rule that decides who becomes an admin
belongs in the trusted file.

**The claim must also be mapped at registration.** Better Auth hands the
provisioning hook a *mapped* user-info object, not the raw claim set, so a claim
it was not told about never arrives. Add it under `mapping.extraFields` —
and note that `mapping.id`, `mapping.email` and `mapping.name` become required
once `mapping` is present at all, so restate the defaults:

```jsonc
"oidcConfig": {
  "clientId": "warehousd-oidc",
  "clientSecret": "oidc-secret",
  "discoveryEndpoint": "…/.well-known/openid-configuration",
  "mapping": {
    "id": "sub",
    "email": "email",
    "emailVerified": "email_verified",
    "name": "name",
    "extraFields": { "groups": "groups" }
  }
}
```

For SAML the same key sits under `samlConfig.mapping.extraFields`, naming the
assertion attribute.

Behaviour worth knowing before you rely on it:

- **Highest role wins.** A user in both `wh-managers` and `wh-admins` is an
  admin. Joining a second group is never a demotion.
- **Unmapped groups are ignored.** An IdP's group list will contain plenty
  warehousd knows nothing about; that is not an error.
- **A missing or empty claim yields `default_role`**, not a refused login. An
  IdP that stops sending groups must not promote anyone, and must not lock
  everyone out either. Membership follows the same rule with one distinction
  that matters: a claim that is *absent* changes nothing at all, while a claim
  that arrives *empty* is an answer — the IdP said this user is in no group, and
  sso-sourced membership is cleared to match. A provider registration that
  forgets to map the claim therefore cannot silently revoke everyone's groups.
- **Console-pinned membership survives a re-sync.** An admin can add groups by
  hand (`PUT /api/admin/users/{id}/groups`); those rows carry `source: 'manual'`
  and an SSO login replaces only the rows it owns. Neither source overwrites the
  other.
- **The ROLE is registration-time only.** The map is applied when the account is
  created, so a promotion or demotion made in **Admin → Users** is never undone
  by the next login. To re-apply it, delete the account and let it be
  provisioned again.
- **MEMBERSHIP syncs on every login.** The same claim also feeds
  `app.user_groups`, which is what a `group:` principal on a per-document ACL
  resolves against — see
  [Per-document ACLs](architecture.md#per-document-acls). That is a fact about
  the directory rather than a decision somebody made in the console, so freezing
  it at first login would be worse than not offering it. The two are told apart
  by a marker table (`app.sso_provisioned`), which is what lets the hook run
  every login without re-deriving the role.
- **A provider with no entry here provisions `member`**, exactly as before.

Both ways this can silently do nothing — the claim never mapped at registration,
or an entry keyed by a `providerId` nobody signs in with — look identical from
outside: everyone lands on `member` and nothing errors. Neither is catchable when
the config is parsed, so warehousd logs a `[sso]` warning at provisioning naming
the provider and the claim. Check the server log if a map appears to be ignored.

## 6. Promote a member by hand

As `admin`, promote the newly-provisioned member in **Admin → Users**, the same
way you would any other account. This is the whole story when no group map is
configured, and the override when one is.

## 7. Local login kill switch (optional)

To force every sign-in through SSO, set:

```bash
WAREHOUSD_DISABLE_LOCAL_LOGIN=true
```

and restart. With this set and no SSO provider configured, the login page
shows "No login method is configured" instead — always register at least one
provider before enabling the kill switch.

---

Next: [connect-claude.md](./connect-claude.md). Once SSO is configured, the
`/mcp/authorize` step delegates to whichever IdP you registered here — so
connecting an assistant is "log in with your company account", never a new
password.
