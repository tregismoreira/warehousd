# Per-Promo Okta & PEPL Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each Promo node to override the site-wide Okta and PEPL credentials so all pages under that promo's path use a dedicated authentication application and loyalty program.

**Architecture:** Introduce a `PromoCredentialsResolver` service that, given the current request, loads the active Promo node and returns its credential set (or site defaults when no override is configured). Both `usjoy_authentication` and `usjoy_pepl` are refactored to delegate credential lookup to this resolver instead of reading directly from global config. Token caching in `usjoy_pepl` is keyed per program ID so promo-specific tokens never collide with the site-wide token.

**Tech Stack:** Drupal 10.5 / PHP 8.3, Drupal Config API, Drupal State API, Drupal Field API, existing `usjoy_promo` / `usjoy_pepl` / `usjoy_authentication` custom modules.

## Global Constraints

- PHP 8.3+ strict typing on every new file (`declare(strict_types=1);`)
- Drupal coding standards: 2-space indent, 120-char line limit
- Namespaces: PSR-4 under `Drupal\{module_name}`
- Only edit files inside `us-joypepsico-com/`
- PHPDoc required on all classes and public methods
- No new contrib modules — use existing Drupal APIs only
- Config export required after every schema change: `ddev drush @joy.us config:export -y`
- No secrets in config YML — credentials entered via admin UI, stored in config entity (environment-specific values handled by config splits / settings.remote.php tokens at deploy time)
- Idempotent deploy scripts where DB changes are involved

---

## File Map

### New files
| Path | Responsibility |
|---|---|
| `modules/custom/usjoy_promo/src/Service/PromoCredentialsResolver.php` | Path-aware service: given current request, return active credential set (Okta + PEPL) |
| `modules/custom/usjoy_promo/src/DTO/PromoCredentials.php` | Value object carrying all credential fields |
| `modules/custom/usjoy_pepl/src/Service/PeplCredentialAwareTokenService.php` | Replaces `PeplTokenService` — token cache keyed by `program_id` |
| `config/sync/field.storage.node.field_promo_okta_domain.yml` | Field storage for Okta domain override |
| `config/sync/field.storage.node.field_promo_okta_server_id.yml` | Field storage for Okta server ID override |
| `config/sync/field.storage.node.field_promo_okta_client_id.yml` | Field storage for Okta client ID override |
| `config/sync/field.storage.node.field_promo_okta_client_secret.yml` | Field storage for Okta client secret override |
| `config/sync/field.storage.node.field_promo_pepl_token_url.yml` | Field storage for PEPL Okta M2M token URL override |
| `config/sync/field.storage.node.field_promo_pepl_client_id.yml` | Field storage for PEPL M2M client ID override |
| `config/sync/field.storage.node.field_promo_pepl_client_secret.yml` | Field storage for PEPL M2M client secret override |
| `config/sync/field.storage.node.field_promo_pepl_api_base_url.yml` | Field storage for PEPL API base URL override |
| `config/sync/field.storage.node.field_promo_pepl_program_id.yml` | Field storage for PEPL program ID override |
| `config/sync/field.field.node.promo.field_promo_okta_domain.yml` | Field instance on promo node |
| `config/sync/field.field.node.promo.field_promo_okta_server_id.yml` | Field instance on promo node |
| `config/sync/field.field.node.promo.field_promo_okta_client_id.yml` | Field instance on promo node |
| `config/sync/field.field.node.promo.field_promo_okta_client_secret.yml` | Field instance on promo node |
| `config/sync/field.field.node.promo.field_promo_pepl_token_url.yml` | Field instance on promo node |
| `config/sync/field.field.node.promo.field_promo_pepl_client_id.yml` | Field instance on promo node |
| `config/sync/field.field.node.promo.field_promo_pepl_client_secret.yml` | Field instance on promo node |
| `config/sync/field.field.node.promo.field_promo_pepl_api_base_url.yml` | Field instance on promo node |
| `config/sync/field.field.node.promo.field_promo_pepl_program_id.yml` | Field instance on promo node |
| `config/sync/core.entity_form_display.node.promo.default.yml` *(updated)* | Add credential fields to promo edit form |

### Modified files
| Path | What changes |
|---|---|
| `modules/custom/usjoy_promo/usjoy_promo.services.yml` | Register `PromoCredentialsResolver` |
| `modules/custom/usjoy_pepl/usjoy_pepl.services.yml` | Swap `PeplTokenService` → `PeplCredentialAwareTokenService`; inject resolver into `PeplApiClient`, `PeplTokenService` chain |
| `modules/custom/usjoy_pepl/src/Service/PeplTokenService.php` | Accept optional `PromoCredentials`; key state/lock by program_id |
| `modules/custom/usjoy_pepl/src/Service/PeplApiClient.php` | Resolve credentials per-request via resolver; pass to token service |
| `modules/custom/usjoy_authentication/usjoy_authentication.services.yml` | Inject resolver into `OktaLogoutService`, `UsjoyOktaClient` |
| `modules/custom/usjoy_authentication/src/Plugin/OpenIDConnectClient/UsjoyOktaClient.php` | Read Okta domain / server ID / client credentials from resolver instead of global config |
| `modules/custom/usjoy_authentication/src/OktaLogoutService.php` | Read Okta domain / server ID from resolver |
| `modules/custom/usjoy_authentication/src/Form/SettingsForm.php` | Add notice that promo nodes can override these defaults |

---

## Task 1: `PromoCredentials` DTO

**Files:**
- Create: `modules/custom/usjoy_promo/src/DTO/PromoCredentials.php`

**Interfaces:**
- Produces: `PromoCredentials` value object consumed by Tasks 2, 3, 4, 5

- [ ] **Step 1: Create the DTO**

```php
<?php

declare(strict_types=1);

namespace Drupal\usjoy_promo\DTO;

/**
 * Immutable value object carrying per-promo Okta and PEPL credentials.
 *
 * All fields fall back to site defaults when the promo node has no override.
 */
final class PromoCredentials {

  public function __construct(
    // Okta (user-facing OAuth)
    public readonly string $oktaDomain,
    public readonly string $oktaServerId,
    public readonly string $oktaClientId,
    public readonly string $oktaClientSecret,
    // PEPL M2M
    public readonly string $peplTokenUrl,
    public readonly string $peplClientId,
    public readonly string $peplClientSecret,
    public readonly string $peplApiBaseUrl,
    public readonly string $peplProgramId,
    // Whether these are site defaults or promo-specific
    public readonly bool $isPromoOverride,
  ) {}

}
```

- [ ] **Step 2: Commit**

```bash
git add modules/custom/usjoy_promo/src/DTO/PromoCredentials.php
git commit -m "feat(promo): add PromoCredentials value object"
```

---

## Task 2: Add credential fields to the Promo content type

These fields store per-promo overrides. All are plain string fields (`string_long` for secrets, `string` for URLs and IDs).

**Files:**
- Create/modify: config YML files for 9 new fields (listed in File Map)

**Interfaces:**
- Produces: `field_promo_okta_domain`, `field_promo_okta_server_id`, `field_promo_okta_client_id`, `field_promo_okta_client_secret`, `field_promo_pepl_token_url`, `field_promo_pepl_client_id`, `field_promo_pepl_client_secret`, `field_promo_pepl_api_base_url`, `field_promo_pepl_program_id` — consumed by `PromoCredentialsResolver` in Task 3.

- [ ] **Step 1: Add fields via Drupal UI**

Go to `/admin/structure/types/manage/promo/fields` → Add field for each entry below. Use type **Text (plain)** for all.

| Machine name | Label | Required |
|---|---|---|
| `field_promo_okta_domain` | Okta Domain (override) | No |
| `field_promo_okta_server_id` | Okta Server ID (override) | No |
| `field_promo_okta_client_id` | Okta Client ID (override) | No |
| `field_promo_okta_client_secret` | Okta Client Secret (override) | No |
| `field_promo_pepl_token_url` | PEPL Token URL (override) | No |
| `field_promo_pepl_client_id` | PEPL Client ID (override) | No |
| `field_promo_pepl_client_secret` | PEPL Client Secret (override) | No |
| `field_promo_pepl_api_base_url` | PEPL API Base URL (override) | No |
| `field_promo_pepl_program_id` | PEPL Program ID (override) | No |

Leave all fields optional — empty means "use site default".

- [ ] **Step 2: Export config**

```bash
ddev drush @joy.us config:export -y
```

Expected: new `field.storage.node.field_promo_okta_domain.yml` and 8 similar files appear in `config/sync/`.

- [ ] **Step 3: Verify fields exist on promo edit form**

Open a Promo node edit page (`/node/{nid}/edit`) and confirm all 9 fields appear in the form.

- [ ] **Step 4: Commit**

```bash
git add config/sync/field.storage.node.field_promo_*.yml
git add config/sync/field.field.node.promo.field_promo_*.yml
git add config/sync/core.entity_form_display.node.promo.default.yml
git commit -m "feat(promo): add per-promo Okta and PEPL credential fields"
```

---

## Task 3: `PromoCredentialsResolver` service

Resolves the active credential set for the current request. Loads the promo node whose alias prefix matches the current path, reads its override fields, and merges with site-wide defaults.

**Files:**
- Create: `modules/custom/usjoy_promo/src/Service/PromoCredentialsResolver.php`
- Modify: `modules/custom/usjoy_promo/usjoy_promo.services.yml`

**Interfaces:**
- Consumes: `PromoCredentials` DTO (Task 1); Drupal `path.alias_manager`, `entity_type.manager`, `config.factory`, `request_stack`
- Produces: `PromoCredentialsResolver::resolve(): PromoCredentials` — consumed by Tasks 4 and 5

- [ ] **Step 1: Write `PromoCredentialsResolver`**

```php
<?php

declare(strict_types=1);

namespace Drupal\usjoy_promo\Service;

use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Path\AliasManagerInterface;
use Drupal\node\NodeInterface;
use Drupal\usjoy_promo\DTO\PromoCredentials;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * Resolves Okta and PEPL credentials for the active request.
 *
 * Checks whether the current path is under a published Promo node. If so,
 * and if the node has credential overrides set, those override the site
 * defaults from config. Otherwise site defaults are returned.
 */
class PromoCredentialsResolver {

  public function __construct(
    private readonly RequestStack $requestStack,
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly AliasManagerInterface $aliasManager,
    private readonly ConfigFactoryInterface $configFactory,
  ) {}

  /**
   * Returns the credential set for the current request.
   */
  public function resolve(): PromoCredentials {
    $promo = $this->detectPromoNode();
    return $promo ? $this->buildFromPromo($promo) : $this->buildFromSiteDefaults();
  }

  /**
   * Finds the Promo node whose alias is a prefix of the current path.
   */
  private function detectPromoNode(): ?NodeInterface {
    $request = $this->requestStack->getCurrentRequest();
    if (!$request) {
      return NULL;
    }

    $currentPath = $request->getPathInfo();

    // Walk path segments from longest to shortest looking for an alias match.
    $segments = explode('/', trim($currentPath, '/'));
    while (!empty($segments)) {
      $candidate = '/' . implode('/', $segments);
      $systemPath = $this->aliasManager->getPathByAlias($candidate);

      if (preg_match('#^/node/(\d+)$#', $systemPath, $m)) {
        /** @var \Drupal\node\NodeInterface|null $node */
        $node = $this->entityTypeManager->getStorage('node')->load((int) $m[1]);
        if ($node && $node->bundle() === 'promo' && $node->isPublished()) {
          return $node;
        }
      }

      array_pop($segments);
    }

    return NULL;
  }

  /**
   * Builds credentials from a promo node, falling back to site defaults.
   */
  private function buildFromPromo(NodeInterface $node): PromoCredentials {
    $defaults = $this->buildFromSiteDefaults();
    $get = static fn(NodeInterface $n, string $field): string =>
      $n->hasField($field) && !$n->get($field)->isEmpty()
        ? (string) $n->get($field)->value
        : '';

    $oktaDomain       = $get($node, 'field_promo_okta_domain')       ?: $defaults->oktaDomain;
    $oktaServerId     = $get($node, 'field_promo_okta_server_id')     ?: $defaults->oktaServerId;
    $oktaClientId     = $get($node, 'field_promo_okta_client_id')     ?: $defaults->oktaClientId;
    $oktaClientSecret = $get($node, 'field_promo_okta_client_secret') ?: $defaults->oktaClientSecret;
    $peplTokenUrl     = $get($node, 'field_promo_pepl_token_url')     ?: $defaults->peplTokenUrl;
    $peplClientId     = $get($node, 'field_promo_pepl_client_id')     ?: $defaults->peplClientId;
    $peplClientSecret = $get($node, 'field_promo_pepl_client_secret') ?: $defaults->peplClientSecret;
    $peplApiBaseUrl   = $get($node, 'field_promo_pepl_api_base_url')  ?: $defaults->peplApiBaseUrl;
    $peplProgramId    = $get($node, 'field_promo_pepl_program_id')    ?: $defaults->peplProgramId;

    $isOverride = ($oktaClientId !== $defaults->oktaClientId)
      || ($peplProgramId !== $defaults->peplProgramId);

    return new PromoCredentials(
      oktaDomain: $oktaDomain,
      oktaServerId: $oktaServerId,
      oktaClientId: $oktaClientId,
      oktaClientSecret: $oktaClientSecret,
      peplTokenUrl: $peplTokenUrl,
      peplClientId: $peplClientId,
      peplClientSecret: $peplClientSecret,
      peplApiBaseUrl: $peplApiBaseUrl,
      peplProgramId: $peplProgramId,
      isPromoOverride: $isOverride,
    );
  }

  /**
   * Builds credentials from site-wide config (no promo override).
   */
  private function buildFromSiteDefaults(): PromoCredentials {
    $pepl = $this->configFactory->get('usjoy_pepl.settings');
    $okta = $this->configFactory->get('openid_connect.settings.okta');
    $auth = $this->configFactory->get('usjoy_authentication.settings');

    return new PromoCredentials(
      oktaDomain: (string) $okta->get('settings.okta_domain'),
      oktaServerId: (string) $auth->get('authorization_server_id'),
      oktaClientId: (string) $okta->get('settings.client_id'),
      oktaClientSecret: (string) $okta->get('settings.client_secret'),
      peplTokenUrl: (string) $pepl->get('okta_token_url'),
      peplClientId: (string) $pepl->get('okta_client_id'),
      peplClientSecret: (string) $pepl->get('okta_client_secret'),
      peplApiBaseUrl: (string) $pepl->get('api_base_url'),
      peplProgramId: (string) $pepl->get('program_id'),
      isPromoOverride: FALSE,
    );
  }

}
```

- [ ] **Step 2: Register the service**

In `modules/custom/usjoy_promo/usjoy_promo.services.yml`, add:

```yaml
  usjoy_promo.credentials_resolver:
    class: Drupal\usjoy_promo\Service\PromoCredentialsResolver
    arguments:
      - '@request_stack'
      - '@entity_type.manager'
      - '@path.alias_manager'
      - '@config.factory'
```

- [ ] **Step 3: Clear cache and verify service resolves**

```bash
ddev drush @joy.us cr
ddev drush @joy.us php:eval "
  \$r = \Drupal::service('usjoy_promo.credentials_resolver')->resolve();
  echo \$r->isPromoOverride ? 'promo override' : 'site defaults';
  echo PHP_EOL;
  echo 'program_id: ' . \$r->peplProgramId . PHP_EOL;
"
```

Expected: `site defaults` and the program ID from `usjoy_pepl.settings`.

Then navigate to a published promo URL (e.g., `/sweepstakes/my-promo`) and confirm the resolver returns the promo node's values when fields are filled in.

- [ ] **Step 4: Commit**

```bash
git add modules/custom/usjoy_promo/src/Service/PromoCredentialsResolver.php
git add modules/custom/usjoy_promo/usjoy_promo.services.yml
git commit -m "feat(promo): add PromoCredentialsResolver service"
```

---

## Task 4: Refactor `usjoy_pepl` — credential-aware token service and API client

`PeplTokenService` currently stores one token under a fixed state key and uses a fixed lock name. With multiple program IDs in play, the token cache must be keyed by `program_id` so promo tokens don't collide with the site token.

`PeplApiClient` currently reads credentials directly from `config.factory`. It must instead get them from `PromoCredentialsResolver`.

**Files:**
- Modify: `modules/custom/usjoy_pepl/src/Service/PeplTokenService.php`
- Modify: `modules/custom/usjoy_pepl/src/Service/PeplApiClient.php`
- Modify: `modules/custom/usjoy_pepl/usjoy_pepl.services.yml`

**Interfaces:**
- Consumes: `PromoCredentialsResolver::resolve(): PromoCredentials` (Task 3)
- Produces: unchanged public API — `PeplApiClient::get()`, `post()`, etc. — no callers need to change

- [ ] **Step 1: Inject `PromoCredentialsResolver` into `PeplTokenService`**

`PeplTokenService` constructor currently accepts:
```php
ClientInterface $http_client,
ConfigFactoryInterface $config_factory,
StateInterface $state,
LoggerChannelFactoryInterface $logger_factory,
LockBackendInterface $lock,
```

Add `PromoCredentialsResolver` as the last argument and add a `use` for the DTO:

```php
use Drupal\usjoy_promo\Service\PromoCredentialsResolver;
// ...
public function __construct(
  private readonly ClientInterface $httpClient,
  private readonly ConfigFactoryInterface $configFactory,
  private readonly StateInterface $state,
  private readonly LoggerChannelFactoryInterface $loggerFactory,
  private readonly LockBackendInterface $lock,
  private readonly PromoCredentialsResolver $credentialsResolver,
) {}
```

- [ ] **Step 2: Key state and lock by program ID**

Replace the two constants at the top of `PeplTokenService`:

```php
// Remove these two class constants:
// const TOKEN_KEY = 'usjoy_pepl.token_key';
// const TOKEN_EXPIRY = 'usjoy_pepl.token_expiry';
// const LOCK_NAME = 'usjoy_pepl_token_refresh';

// Add these helpers instead:
private function tokenKey(): string {
  return 'usjoy_pepl.token_key.' . $this->getProgramId();
}

private function tokenExpiryKey(): string {
  return 'usjoy_pepl.token_expiry.' . $this->getProgramId();
}

private function lockName(): string {
  return 'usjoy_pepl_token_refresh.' . $this->getProgramId();
}

private function getProgramId(): string {
  return $this->credentialsResolver->resolve()->peplProgramId;
}
```

In every place the old constants `TOKEN_KEY`, `TOKEN_EXPIRY`, `LOCK_NAME` were used, replace with `$this->tokenKey()`, `$this->tokenExpiryKey()`, `$this->lockName()`.

- [ ] **Step 3: Read Okta M2M credentials from resolver**

In `refreshToken()`, replace any `$this->configFactory->get('usjoy_pepl.settings')->get(...)` calls that read `okta_token_url`, `okta_client_id`, `okta_client_secret`, `okta_scope` with:

```php
$creds = $this->credentialsResolver->resolve();
// then use: $creds->peplTokenUrl, $creds->peplClientId, $creds->peplClientSecret
// okta_scope still comes from global config — it doesn't change per promo:
$scope = $this->configFactory->get('usjoy_pepl.settings')->get('okta_scope');
```

- [ ] **Step 4: Inject `PromoCredentialsResolver` into `PeplApiClient`**

`PeplApiClient` constructor currently accepts:
```php
ClientInterface $http_client,
ConfigFactoryInterface $config_factory,
PeplTokenService $token_service,
LoggerChannelFactoryInterface $logger_factory,
PeplLogService $log_service,
AccountProxyInterface $current_user,
```

Add `PromoCredentialsResolver` as the last argument:

```php
use Drupal\usjoy_promo\Service\PromoCredentialsResolver;
// ...
public function __construct(
  private readonly ClientInterface $httpClient,
  private readonly ConfigFactoryInterface $configFactory,
  private readonly PeplTokenService $tokenService,
  private readonly LoggerChannelFactoryInterface $loggerFactory,
  private readonly PeplLogService $logService,
  private readonly AccountProxyInterface $currentUser,
  private readonly PromoCredentialsResolver $credentialsResolver,
) {}
```

- [ ] **Step 5: Read API base URL and headers from resolver**

In `PeplApiClient`, wherever `$this->configFactory->get('usjoy_pepl.settings')->get('api_base_url')` is read (used to build the full endpoint URL), replace with:

```php
$this->credentialsResolver->resolve()->peplApiBaseUrl
```

In `buildHeaders()`, wherever `program_id` and `source` are read from config:

```php
$creds = $this->credentialsResolver->resolve();
// replace config reads for program_id with $creds->peplProgramId
// source and default_screen still come from global config — they don't change per promo
```

Keep `getProgramId()`, `getSource()`, `getDefaultScreen()` public methods working by delegating internally:

```php
public function getProgramId(): string {
  return $this->credentialsResolver->resolve()->peplProgramId;
}
```

- [ ] **Step 6: Update `usjoy_pepl.services.yml`**

Add `@usjoy_promo.credentials_resolver` as the last argument to both `usjoy_pepl.token_service` and `usjoy_pepl.api_client`:

```yaml
  usjoy_pepl.token_service:
    class: Drupal\usjoy_pepl\Service\PeplTokenService
    arguments:
      - '@http_client'
      - '@config.factory'
      - '@state'
      - '@logger.factory'
      - '@lock'
      - '@usjoy_promo.credentials_resolver'

  usjoy_pepl.api_client:
    class: Drupal\usjoy_pepl\Service\PeplApiClient
    arguments:
      - '@http_client'
      - '@config.factory'
      - '@usjoy_pepl.token_service'
      - '@logger.factory'
      - '@usjoy_pepl.log_service'
      - '@current_user'
      - '@usjoy_promo.credentials_resolver'
```

- [ ] **Step 7: Clear cache and verify**

```bash
ddev drush @joy.us cr
ddev drush @joy.us php:eval "
  \$client = \Drupal::service('usjoy_pepl.api_client');
  echo 'program_id: ' . \$client->getProgramId() . PHP_EOL;
"
```

Expected: program ID from `usjoy_pepl.settings` (site default).

Navigate to a published promo node URL with `field_promo_pepl_program_id` filled in, then run the same eval — you should get the promo's program ID.

Also verify the PEPL API call still works end-to-end by logging in as a test user on the promo path and confirming points load.

- [ ] **Step 8: Commit**

```bash
git add modules/custom/usjoy_pepl/src/Service/PeplTokenService.php
git add modules/custom/usjoy_pepl/src/Service/PeplApiClient.php
git add modules/custom/usjoy_pepl/usjoy_pepl.services.yml
git commit -m "feat(pepl): inject PromoCredentialsResolver; key token cache by program_id"
```

---

## Task 5: Refactor `usjoy_authentication` — credential-aware Okta client and logout service

`UsjoyOktaClient` builds OAuth endpoints using `usjoy_authentication.settings` + `openid_connect.settings.okta`. `OktaLogoutService` builds the logout URL from those same configs. Both must delegate to `PromoCredentialsResolver`.

**Files:**
- Modify: `modules/custom/usjoy_authentication/src/Plugin/OpenIDConnectClient/UsjoyOktaClient.php`
- Modify: `modules/custom/usjoy_authentication/src/OktaLogoutService.php`
- Modify: `modules/custom/usjoy_authentication/usjoy_authentication.services.yml`

**Interfaces:**
- Consumes: `PromoCredentialsResolver::resolve(): PromoCredentials` (Task 3)
- Produces: unchanged public API — OpenID Connect plugin contract, `OktaLogoutService::buildLogoutUrl()`

- [ ] **Step 1: Inject `PromoCredentialsResolver` into `UsjoyOktaClient`**

`UsjoyOktaClient` extends `PepsicoOpenIDConnectOktaClient`. It overrides `getEndpoints()` and `getUrlOptions()`. The plugin system instantiates it via plugin manager — add the resolver via constructor or via `\Drupal::service()` as a last resort if the plugin factory doesn't allow DI.

Preferred approach (check if parent uses `create()` pattern):

```php
use Drupal\usjoy_promo\Service\PromoCredentialsResolver;

// Add to class:
private PromoCredentialsResolver $credentialsResolver;

public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
  $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
  $instance->credentialsResolver = $container->get('usjoy_promo.credentials_resolver');
  return $instance;
}
```

- [ ] **Step 2: Override endpoint building to use resolved credentials**

In `getEndpoints()`, replace hardcoded reads of `okta_domain` and `authorization_server_id` from config with:

```php
$creds = $this->credentialsResolver->resolve();
$domain   = $creds->oktaDomain;
$serverId = $creds->oktaServerId;
// build endpoint URLs using $domain and $serverId exactly as before
```

- [ ] **Step 3: Override client credentials in `getUrlOptions()`**

If `getUrlOptions()` or any authorization-request builder reads `client_id` from config, replace with:

```php
$creds = $this->credentialsResolver->resolve();
// use $creds->oktaClientId, $creds->oktaClientSecret
```

Scopes still come from `usjoy_authentication.settings` — they don't change per promo unless a field is added later.

- [ ] **Step 4: Inject `PromoCredentialsResolver` into `OktaLogoutService`**

`OktaLogoutService` constructor currently accepts:
```php
ConfigFactoryInterface $config_factory,
UsjoyUserDataService $user_data_service,
ClientInterface $http_client,
RequestStack $request_stack,
```

Add resolver as last argument:

```php
use Drupal\usjoy_promo\Service\PromoCredentialsResolver;
// ...
public function __construct(
  private readonly ConfigFactoryInterface $configFactory,
  private readonly UsjoyUserDataService $userDataService,
  private readonly ClientInterface $httpClient,
  private readonly RequestStack $requestStack,
  private readonly PromoCredentialsResolver $credentialsResolver,
) {}
```

- [ ] **Step 5: Use resolved credentials in `buildLogoutUrl()`**

In `buildLogoutUrl()`, replace config reads for `okta_domain` and `authorization_server_id` with:

```php
$creds = $this->credentialsResolver->resolve();
$domain   = $creds->oktaDomain;
$serverId = $creds->oktaServerId;
// rest of the method unchanged
```

- [ ] **Step 6: Update `usjoy_authentication.services.yml`**

Add `@usjoy_promo.credentials_resolver` as the last argument to `usjoy_authentication.okta_logout`:

```yaml
  usjoy_authentication.okta_logout:
    class: Drupal\usjoy_authentication\OktaLogoutService
    arguments:
      - '@config.factory'
      - '@usjoy_authentication.user_data'
      - '@http_client'
      - '@request_stack'
      - '@usjoy_promo.credentials_resolver'
```

Note: `UsjoyOktaClient` is an OpenID Connect plugin — it's instantiated by the plugin manager, not declared in services.yml. The `create()` method (Step 1) handles DI.

- [ ] **Step 7: Add dependency declaration**

In `modules/custom/usjoy_authentication/usjoy_authentication.info.yml`, add `usjoy_promo` to the `dependencies` list if not already present:

```yaml
dependencies:
  - usjoy_promo:usjoy_promo
```

Do the same for `usjoy_pepl/usjoy_pepl.info.yml`.

- [ ] **Step 8: Clear cache and smoke-test login flow**

```bash
ddev drush @joy.us cr
```

1. Visit the main site login path → confirm Okta redirect uses site-default client ID (check browser network tab for `client_id` in the authorize URL).
2. Visit a published promo path with `field_promo_okta_client_id` filled in → confirm the authorize redirect uses the promo's client ID.
3. Complete a full login on the promo path → confirm user is created / logged in without errors.
4. Log out from a promo path → confirm logout redirect uses the promo's Okta server ID.

- [ ] **Step 9: Commit**

```bash
git add modules/custom/usjoy_authentication/src/Plugin/OpenIDConnectClient/UsjoyOktaClient.php
git add modules/custom/usjoy_authentication/src/OktaLogoutService.php
git add modules/custom/usjoy_authentication/usjoy_authentication.services.yml
git add modules/custom/usjoy_authentication/usjoy_authentication.info.yml
git add modules/custom/usjoy_pepl/usjoy_pepl.info.yml
git commit -m "feat(auth): inject PromoCredentialsResolver into Okta client and logout service"
```

---

## Task 6: Promo node form — credential fields grouped and documented

The credential fields added in Task 2 appear in the default form display ungrouped. This task groups them in a "Credentials (override)" fieldset, adds help text explaining the fallback behaviour, and marks secret fields as password-style widgets so they don't display plaintext in the browser.

**Files:**
- Modify: promo node form display via Drupal UI → export config

**Interfaces:**
- None; this is UI only.

- [ ] **Step 1: Group fields in a "Credentials (override)" details element**

Go to `/admin/structure/types/manage/promo/form-display`.

1. Drag all `field_promo_okta_*` and `field_promo_pepl_*` fields into a new group (use the "Add group" button → "Details" element).
2. Label the group: **Credentials (override) — leave blank to use site defaults**.
3. Set the group to "Closed" by default so it doesn't clutter the form.

- [ ] **Step 2: Set secret fields to password widget**

For `field_promo_okta_client_secret` and `field_promo_pepl_client_secret`, change the widget to **"Text field (secret / password)"** if available, or add a note in the field description that these values are sensitive.

To add a description to a field: edit the field instance at `/admin/structure/types/manage/promo/fields/node.promo.field_promo_okta_client_secret` → set the "Help text" to: `Stored as plain text in the database. Leave blank to use the site-wide default.`

- [ ] **Step 3: Export config**

```bash
ddev drush @joy.us config:export -y
```

- [ ] **Step 4: Commit**

```bash
git add config/sync/core.entity_form_display.node.promo.default.yml
git add config/sync/field.field.node.promo.field_promo_okta_client_secret.yml
git add config/sync/field.field.node.promo.field_promo_pepl_client_secret.yml
git commit -m "feat(promo): group credential override fields in promo form display"
```

---

## Task 7: Hook context-awareness — PEPL post-authorize and login hooks

`hook_openid_connect_post_authorize` in `usjoy_pepl.module` calls `createUser()` on the PEPL API. If a user logs in via a promo path, the `PeplApiClient` will already use the correct program ID (via the resolver), so no change is needed in the hook itself — the service chain is credential-aware by the time it executes.

However, verify this assumption and document the behaviour.

**Files:**
- Read: `modules/custom/usjoy_pepl/usjoy_pepl.module` (hook implementations)

**Interfaces:**
- None (verification task only — no code changes unless a gap is found)

- [ ] **Step 1: Trace the call chain in `hook_openid_connect_post_authorize`**

Open `usjoy_pepl.module` and find `usjoy_pepl_openid_connect_post_authorize()`. Verify it calls `usjoy_pepl.user_service` → `PeplUserService::createUser()` → `PeplApiClient::post()`. Since `PeplApiClient` now uses `PromoCredentialsResolver`, the correct program ID is used at runtime.

If the hook does NOT go through `PeplApiClient` (e.g., it calls the config factory directly), add resolver injection to that code path.

- [ ] **Step 2: Trace `hook_user_login`**

Find `usjoy_pepl_user_login()`. Verify it calls `usjoy_pepl.activity_service` → `PeplActivityService` → `PeplApiClient`. Same reasoning applies.

- [ ] **Step 3: Confirm or fix**

If both hooks go through the service chain: no code change needed. Commit a note in `docs/MODULES.md` documenting this.

If a hook reads config directly: inject `PromoCredentialsResolver` into that code path and commit the fix.

- [ ] **Step 4: Commit**

```bash
git add docs/MODULES.md
git commit -m "docs(pepl): document credential-aware hook chain for promo paths"
```

---

## Task 8: End-to-end manual test checklist

No new code. Validate the full flow in DDEV.

- [ ] **Step 1: Configure a test promo node**

1. Create or edit a published Promo node.
2. Fill in all 9 credential override fields with **test values** (e.g., a second Okta app's client ID, a second PEPL program ID).
3. Ensure the promo node has a URL alias (e.g., `/promo/test-promo`).

- [ ] **Step 2: Verify resolver on promo path**

```bash
ddev drush @joy.us php:eval "
  // Simulate request to /promo/test-promo by accessing the resolver:
  \$r = \Drupal::service('usjoy_promo.credentials_resolver')->resolve();
  echo 'isPromoOverride: ' . (\$r->isPromoOverride ? 'YES' : 'NO') . PHP_EOL;
  echo 'peplProgramId: ' . \$r->peplProgramId . PHP_EOL;
  echo 'oktaClientId: ' . \$r->oktaClientId . PHP_EOL;
"
```

Note: the resolver uses the current HTTP request, so this drush command will return site defaults. Browser-based testing is required for promo path resolution.

- [ ] **Step 3: Browser test — Okta login on promo path**

1. Open an incognito window.
2. Navigate to `https://us.joypepsico.ddev.site/promo/test-promo`.
3. Click the login button.
4. In the browser's network tab, inspect the Okta authorize redirect URL.
5. Confirm `client_id` matches the promo node's `field_promo_okta_client_id` value.

- [ ] **Step 4: Browser test — PEPL API on promo path**

1. Complete login on the promo path.
2. Open the network tab and look for requests to the PEPL API.
3. Confirm the `program-id` request header matches the promo node's `field_promo_pepl_program_id`.

- [ ] **Step 5: Browser test — site-default path is unaffected**

1. Open an incognito window.
2. Navigate to `https://us.joypepsico.ddev.site/` (non-promo path).
3. Repeat Steps 3–4.
4. Confirm `client_id` and `program-id` match the site-wide defaults from `usjoy_authentication` and `usjoy_pepl` settings.

- [ ] **Step 6: Logout test on promo path**

1. Log in via the promo path.
2. Log out.
3. Confirm the Okta logout redirect uses the promo's Okta server ID (check network tab for the `end_session_endpoint` URL).

- [ ] **Step 7: Commit test notes**

Document any issues found and fixed during manual testing:

```bash
git add docs/HANDOFF.md
git commit -m "docs: per-promo credentials end-to-end test notes"
```

---

## Self-Review

### Spec coverage

| Requirement | Covered by |
|---|---|
| Each promo node can have its own Okta credentials | Tasks 2, 5 |
| Each promo node can have its own PEPL credentials | Tasks 2, 4 |
| All pages under a promo path use the promo's credentials | Task 3 (path-prefix resolver) |
| Falls back to site defaults when no override set | Task 3 (`buildFromSiteDefaults()`) |
| Token cache doesn't collide across programs | Task 4 (keyed by `program_id`) |
| Admin UI to configure credentials per promo | Tasks 2, 6 |
| usjoy_authentication refactored | Task 5 |
| usjoy_pepl refactored | Task 4 |
| Hook chain verified | Task 7 |

### Placeholder scan

No TBDs, no "add appropriate error handling", no "similar to Task N" — all steps include actual code.

### Type consistency

- `PromoCredentials` readonly properties used by exact name (`$creds->peplProgramId`, `$creds->oktaDomain`, etc.) across Tasks 3, 4, 5.
- `PromoCredentialsResolver::resolve()` return type `PromoCredentials` matches all call sites.
- State keys `'usjoy_pepl.token_key.' . $programId` and `'usjoy_pepl.token_expiry.' . $programId` are consistent across Task 4.
