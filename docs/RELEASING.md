# Releasing warehousd

A release publishes two artifacts from one git tag:

- the server image, `ghcr.io/tregismoreira/warehousd`
- the CLI npm package, `warehousd`

They are coupled: `warehousd start` pulls `ghcr.io/tregismoreira/warehousd:<cli-version>`,
where `<cli-version>` is baked into the bundle by tsup at build time. **The Docker tag the
release pushes is bare — `0.2.0`, not `v0.2.0`.** The `v` prefix lives only on the git tag.

## Cutting a release

```bash
cd mvp/packages/cli
npm version 0.2.0 --no-git-tag-version   # or edit package.json by hand
cd -
git commit -am "release: warehousd v0.2.0"
git tag v0.2.0
git push --follow-tags
```

The tag must be `v` + the exact `version` in `mvp/packages/cli/package.json`. The workflow
refuses to run otherwise.

## What `.github/workflows/release.yml` does

| Job | Needs | What it does |
|---|---|---|
| `verify` | — | Rejects non-tag refs (so a stray `workflow_dispatch` can't publish), asserts the tag matches the package version, and emits `version` (bare) plus `prerelease`. Holds no permissions. |
| `image` | `verify` | Builds `mvp/apps/web/Dockerfile` for amd64 + arm64 and pushes `:<version>` (what the CLI pulls), `:v<version>` (for humans), and `:latest` — the last only when the version has no prerelease suffix. |
| `npm` | `verify`, `image` | Builds and publishes the CLI with `--provenance`. Requires the `NPM_TOKEN` secret. |

Ordering matters: the version check used to live in the npm job, so a bad run could move
`:latest` before anything validated it.

## Prereleases

Any version containing a `-` is treated as a prerelease and does **not** move `:latest`:

```bash
# in packages/cli/package.json: "version": "0.3.0-rc.1"
git tag v0.3.0-rc.1 && git push --follow-tags
```

Note that npm still publishes it under the `latest` dist-tag unless you add `--tag next` to
the publish step — the prerelease handling above covers the Docker side only.

## Verifying a release

```bash
# The image must be pullable anonymously — run this somewhere not logged into ghcr.io
docker pull ghcr.io/tregismoreira/warehousd:0.2.0

# The full consumer path, from a clean directory
mkdir /tmp/wd && cd /tmp/wd
npx warehousd@0.2.0 init
npx warehousd@0.2.0 start
npx warehousd@0.2.0 status
npx warehousd@0.2.0 stop --destroy --yes
```

Provenance should show as a "Built and signed on GitHub Actions" badge on
<https://www.npmjs.com/package/warehousd>.

## One-time setup

Before the first tag push:

1. **The repo must be public.** npm dropped provenance support for private repos in 2023, so
   `--provenance` hard-fails otherwise.
2. **`NPM_TOKEN` repo secret** — an npm Granular Access Token, type *Automation*, permission
   *Read and write*.

Immediately after the first release:

3. **Make the GHCR package public.**
   `github.com/users/tregismoreira/packages/container/warehousd/settings` → Change visibility →
   Public. A package first pushed from a private repo is private, so anonymous `docker pull`
   fails until you flip it. Under *Manage Actions access*, also add the `warehousd` repo with
   **Write** so later releases can push. ⚠️ Public is irreversible for that package.
4. **Switch to npm Trusted Publishing (OIDC)** and delete `NPM_TOKEN` — this can only be
   configured once the package exists.

## Moving the GHCR namespace

`IMAGE_REPO` in `mvp/packages/cli/src/image.ts` is the single source of truth. If the repo
moves to an org, change that line and the `tags:` block in `release.yml`. Already-published CLI
versions keep their baked-in reference forever, so **never delete the old GHCR package** — only
new CLI versions point at the new namespace.
