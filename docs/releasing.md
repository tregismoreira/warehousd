# Releasing warehousd

A release publishes two artifacts from one git tag:

- the server image, `ghcr.io/tregismoreira/warehousd`
- the CLI npm package, `warehousd`

They are coupled: `warehousd start` pulls `ghcr.io/tregismoreira/warehousd:<cli-version>`, where `<cli-version>` is baked into the bundle by tsup at build time. **The Docker tag the release pushes is bare — `0.2.0`, not `v0.2.0`.** The `v` prefix lives only on the git tag.

A GitHub Release is published alongside them, carrying the generated notes and the packed CLI tarball. It is a record, not a distribution channel: nothing installs from it.

## Versioning policy

Versioning follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). One version number covers both artifacts, because they are pulled as a pair.

**The public surface** — what a version number makes a promise about:

| Surface                                                                       | Documented in            |
| ----------------------------------------------------------------------------- | ------------------------ |
| The MCP tool set: names, input schemas, and refusal reason codes              | `docs/connect-claude.md` |
| The REST API under `/v1/**`: paths, request and response shapes, status codes | `docs/rest-api.md`       |
| The `warehousd.yml` schema                                                    | `docs/configuration.md`  |
| The CLI's commands and flags, and `.warehousd/outputs.json`                   | `docs/cli.md`            |
| The OAuth and token-exchange endpoints, scopes, and grant types               | `docs/configure-sso.md`  |

Everything else is internal and may change in a patch: `@warehousd/broker`'s exports (a private workspace package — see `packages/broker/README.md`), the `app` schema's table layout, the web UI, and anything under `test/`, `scripts/` or `examples/`.

**What each bump means**

- **Major** — a removal from, or an incompatible change to, anything in the table above. Also any change that makes a previously-refused request succeed: in a governed system the refusals are part of the contract, not the gaps in it.
- **Minor** — a tool, endpoint, config key or CLI flag added compatibly. A new _refusal_ that closes a hole is a minor bump, recorded under **Security** in `CHANGELOG.md`.
- **Patch** — a fix that leaves all of the above unchanged.

**Before 1.0.0**, minor bumps may carry breaking changes; that is SemVer's `0.y.z` clause and it is in force here. `CHANGELOG.md` marks every such change explicitly under **Changed**, whatever the digit says.

**Deprecation.** A public-surface item is marked deprecated in `CHANGELOG.md` and in its own documentation for at least one minor release before removal, and keeps working throughout. The stated exception is security: a surface that cannot be made safe is removed in the release that discovers it, and the changelog names that release.

## Cutting a release

Every release updates `CHANGELOG.md`, and the workflow enforces it. Cut the accumulated `## [Unreleased]` section to `## [0.2.0] - YYYY-MM-DD`, leave a new empty `## [Unreleased]` above it, and move the link references at the foot of the file:

```markdown
[Unreleased]: https://github.com/tregismoreira/warehousd/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tregismoreira/warehousd/compare/v0.1.0...v0.2.0
```

Then bump, commit and tag:

```bash
cd packages/cli
npm version 0.2.0 --no-git-tag-version   # or edit package.json by hand
cd -
git commit -am "release: warehousd v0.2.0"
git tag v0.2.0
git push --follow-tags
```

Two things must agree with the tag, and `verify` refuses to run if either does not:

- `version` in `packages/cli/package.json` must be exactly the tag without its `v`.
- `CHANGELOG.md` must carry a `## [0.2.0] - YYYY-MM-DD` heading, dated today or earlier. A date more than fourteen days old is a warning rather than a failure — that is usually a release that slipped after its notes were written, which is worth seeing but not worth blocking.

Nothing else checks the changelog, and a published version's notes cannot be corrected in place afterwards, which is why the check is here rather than left to review.

Then wait. A draft release appears within a minute, the full test suite runs against the tagged commit, and nothing reaches npm or ghcr.io until all of it is green — expect roughly twenty minutes before the release publishes itself.

## Rehearsing one

`workflow_dispatch` on any branch runs the same workflow with publishing switched off:

```bash
gh workflow run release.yml --ref my-branch
gh run watch
```

`verify` decides publish-versus-rehearse from the ref alone — a tag publishes, anything else does not — so there is no input to get wrong and no way for a dispatch to reach a registry. A rehearsal runs the version and changelog checks, the whole of `ci.yml`, the multi-architecture image build and `npm publish --dry-run`; it skips the layer upload, the real publish, and both release jobs.

What it does **not** cover: the `NPM_TOKEN` secret is bound to the `npm-publish` environment, whose deployment rule admits only `v*` tags, so a rehearsal cannot read it. Registry authentication is therefore still first exercised for real on the first tag. That is deliberate — a credential a rehearsal can reach is a credential any branch can reach.

## What `.github/workflows/release.yml` does

| Job       | Needs                             | What it does                                                                                                                                                                                     |
| --------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify`  | —                                 | Emits `publish` (`true` only for a tag), `version` (bare) and `prerelease`. Asserts the tag matches the package version and that `CHANGELOG.md` has a dated section for it. Holds no permissions. |
| `draft`   | `verify`                          | Creates the GitHub Release as a **draft**, with generated notes. Idempotent, so a re-run does not trip over its own first attempt. Skipped on a rehearsal.                                        |
| `gates`   | `verify`                          | Calls `ci.yml` as a reusable workflow: lint, typecheck, format, audit, both vitest passes, the browser suite on three shards, the tarball smoke test and the Docker e2e run — against the tag.    |
| `image`   | `verify`, `gates`                 | Builds `apps/web/Dockerfile` for amd64 + arm64 and pushes `:<version>` (what the CLI pulls), `:v<version>` (for humans), and `:latest` — the last only when the version has no prerelease suffix. On a rehearsal it builds both platforms and pushes nothing. |
| `npm`     | `verify`, `gates`, `image`        | Builds the CLI, packs the tarball as a run artifact, and publishes with `--provenance` under the `latest` or `next` dist-tag — then points `latest` at this version if nothing holds it yet (see [Prereleases](#prereleases)). Runs in the `npm-publish` environment, which is where `NPM_TOKEN` lives. On a rehearsal it runs `--dry-run` instead. |
| `publish` | `verify`, `draft`, `image`, `npm` | Attaches the packed tarball to the release and flips the draft to published (as a prerelease where applicable). Skipped on a rehearsal.                                                           |

Ordering matters twice over. The version check used to live in the npm job, so a bad run could move `:latest` before anything validated it. And until `gates` existed, a tag matched neither of `ci.yml`'s triggers — `push: [main]` nor `pull_request` — so `git push --follow-tags` published whatever the tag pointed at with no test having run against it at all. `ci.yml` is *called*, not copied: a second copy of those jobs would drift from the one pull requests run, and the point of the gate is that a release is held to the same bar a branch is.

One rule holds the whole file together: **only a tag publishes.** It is decided once, in `verify`, from `github.ref_type` and nothing else — not from a workflow input, which whoever starts a run could set. Every step that touches npm, ghcr.io or the release reads that one output.

A release therefore occupies about six runners for roughly twenty minutes before anything reaches a registry. That is the price of the gate, and it is paid on tags only.

## When a gate fails

Nothing was published — `image`, `npm` and `publish` all sit behind `gates`, and a red suite leaves the draft release unpublished. npm and ghcr.io are untouched, so there is nothing to yank.

Tags are not reused. Delete the draft and the tag, fix the branch, and cut a new version:

```bash
gh release delete v0.2.0 --yes
git push --delete origin v0.2.0
git tag -d v0.2.0
```

## When a publish fails

The opposite recovery. `image` and `npm` push to real registries, so a red job there means part of the release may already be out — deleting the tag would strand it. The tag stays; re-run the failed jobs:

```bash
gh run rerun <run-id> --failed
```

Every job in the workflow is safe to repeat. `draft` leaves an existing draft alone, the image push overwrites its own tags, `npm pack` writes to `$RUNNER_TEMP`, `npm dist-tag add` is idempotent, and `gh release upload --clobber` replaces an asset rather than failing on its name. The one step that is not repeatable is `npm publish`, because npm refuses a version it already holds — so a re-run after a publish that *succeeded* and then failed later fails there instead. At that point the version is out and the only move forward is another version.

## The npm credential

`NPM_TOKEN` is a granular access token on the `npm-publish` environment, and it has to be one that **bypasses 2FA**. A token without that setting authenticates perfectly well — well enough to build the tarball, exchange the OIDC token and sign a provenance attestation — and then the publish itself comes back `EOTP`, _"This operation requires a one-time password from your authenticator"_, which no unattended job can answer. It reads like a broken or expired token and is neither.

That token type is being withdrawn. Since 31 July 2026 a 2FA-bypass token can no longer create tokens or change package access, maintainers or trusted-publishing configuration, and [around January 2027 it loses direct publish as well](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/). Its replacement is [trusted publishing](https://docs.npmjs.com/trusted-publishers): OIDC, no stored secret, which is what the `id-token: write` permission on the `npm` job is already there for.

Trusted publishing is configured per package in the package's own settings on npmjs.com, so it cannot be set up for a name the registry does not have yet. **The first release therefore publishes with a token, and no release after it should.** Once `warehousd` exists on npm, add the trusted publisher — repository `tregismoreira/warehousd`, workflow `release.yml`, environment `npm-publish` — and delete the secret. One thing to confirm on the first tag after that, because it is the part OIDC does not obviously cover: the `latest` step runs `npm dist-tag add` as a *second* npm command, after the publish that obtained the credential.

## Prereleases

Any version containing a `-` is treated as a prerelease. It does **not** move the `:latest` image tag, it publishes to npm under the `next` dist-tag rather than `latest`, and the GitHub Release is marked as a prerelease:

```bash
# in packages/cli/package.json: "version": "0.3.0-rc.1"
git tag v0.3.0-rc.1 && git push --follow-tags
```

Installing one is then explicit — `npm i warehousd@next`, or `npx warehousd@0.3.0-rc.1`.

### The exception: before the first stable release

A prerelease goes to `next` because `latest` is what a bare `npm i warehousd` resolves, and a release candidate should not be what an unqualified install gets. That reasoning assumes a stable release already holds `latest`. Until one does, both alternatives are worse than the thing the rule avoids:

- **`latest` unset** — npm answers a bare `npm i warehousd` with `ETARGET`. The package is uninstallable by its own name.
- **`latest` pinned to the first release candidate** — every later RC publishes while unqualified installs go on silently handing out the oldest one. The failure is worse than `ETARGET` precisely because nothing reports it.

So while *every* published version is still a prerelease, the `npm` job points `latest` at the version it just published. The condition is read off the tag itself: if `latest` is unset, or if what holds it is itself a prerelease, this version takes it. It reads back from the registry rather than inferring what npm did with a first publish, so it is correct whichever way npm behaves, and a no-op on a re-run.

The rule is self-limiting and needs no undoing. A stable version publishes with `--tag latest` in the ordinary step, so from that release onward this one reads a non-prerelease and stands down — a later `0.2.0-rc.1` goes to `next` alone while `latest` keeps naming the newest stable. Across a `0.1.0-rc.1 → rc.2 → 0.1.0 → 0.2.0-rc.1` sequence, `latest` reads `rc.1 → rc.2 → 0.1.0 → 0.1.0`.

One wrinkle it does not address: `next` still names the last prerelease after a stable ships, so in the window between `0.1.0` and `0.2.0-rc.1`, `npm i warehousd@next` installs the superseded `0.1.0-rc.2`. It corrects itself at the next prerelease.

The image tags have no equivalent rule, deliberately. `warehousd start` pulls `ghcr.io/tregismoreira/warehousd:<version>` and never `:latest`, so a first release that leaves `:latest` unset breaks nothing; a missing npm `latest` breaks `npx warehousd` outright. The asymmetry is the difference between a tag that is used and a tag that is a convenience.

## Verifying a release

```bash
# The image must be pullable anonymously — run this somewhere not logged into ghcr.io
docker pull ghcr.io/tregismoreira/warehousd:0.1.0-rc.1

# The full consumer path, from a clean directory
mkdir /tmp/wd && cd /tmp/wd
npx warehousd@0.1.0-rc.1 init
npx warehousd@0.1.0-rc.1 start
npx warehousd@0.1.0-rc.1 status
npx warehousd@0.1.0-rc.1 stop --destroy --yes

# And, on a first release, that the bare name resolves at all
npm view warehousd dist-tags
```

Provenance should show as a "Built and signed on GitHub Actions" badge on
<https://www.npmjs.com/package/warehousd>.

## What a release assumes about the registries

Three properties of the publishing setup, stated here because a failing release usually means one of them has drifted rather than that the code is wrong:

- **The repository is public.** npm dropped provenance support for private repositories in 2023, so the `--provenance` flag in the `npm` job hard-fails otherwise.
- **The `npm` job can authenticate to the registry.** Until the package exists that means a 2FA-bypassing `NPM_TOKEN`, and afterwards it should mean trusted publishing — see [The npm credential](#the-npm-credential) for why the distinction has its own section. Either way the secret lives on the `npm-publish` environment rather than on the repository, and that environment admits only `v*` tags: a repository secret is readable from any ref by any workflow, an environment secret is not.
- **The GHCR package is public**, and grants the repository write access under _Manage Actions access_. A container package inherits neither from the repository automatically, and an image that is not anonymously pullable breaks `warehousd start` for every user rather than just for the release.

## Moving the GHCR namespace

`IMAGE_REPO` in `packages/cli/src/image.ts` is the single source of truth. If the repo moves to an org, change that line and the `tags:` block in `release.yml`. Already-published CLI versions keep their baked-in reference forever, so **never delete the old GHCR package** — only new CLI versions point at the new namespace.
