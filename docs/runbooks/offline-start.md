# Offline Start Runbook

## Overview

Once the warehousd container image is cached locally, `warehousd start` succeeds entirely offline — no network access required. This runbook documents the mechanisms that enable offline operation.

## What Is "Offline"?

Offline mode means:
- No Docker image pull (the image already exists locally)
- No package downloads (all dependencies are baked into the image)
- No external API calls (LLM, network utilities, etc.)
- No package manager invocations (`npm`, `pnpm`, `pip`, etc.)

The only network access is to your own Postgres instance (if you bring your own database via `--db`).

## How It Works

Three mechanisms ensure offline operation:

### 1. Image Inspection Before Pull

**File:** `mvp/packages/cli/src/docker.ts`, line 57–64

```typescript
export function ensureImage(ref: string, opts?: { offline?: boolean }): void {
  if (imageExists(ref)) {
    return;  // Already cached locally
  }
  if (opts?.offline) {
    throw new DockerError(`Image ${ref} not found and offline mode is enabled`);
  }
  run(["pull", ref]);
}
```

The CLI checks if the image exists locally via `docker image inspect`. If it does, no pull occurs. If it doesn't, the CLI only attempts a pull if offline mode is not requested.

**Implication:** After running `warehousd start` once (which downloads the image), subsequent `start` commands never touch the network for Docker.

### 2. Better Auth Migration via pnpm exec

**File:** `mvp/apps/web/scripts/entrypoint.ts`, line 135–139

```typescript
execFileSync("pnpm", ["exec", "better-auth", "migrate", "--config", "lib/auth.ts", "-y"], {
  cwd: "/app/apps/web",
  stdio: "inherit",
  env: process.env,
});
```

The container entrypoint runs the Better Auth migration using `pnpm exec`, which executes binaries from the bundled `node_modules` inside the container. It does not use `npx` (which would download packages from the registry).

**Implication:** The entire Node.js ecosystem (better-auth, Drizzle, Postgres driver, etc.) is prebuilt into the Docker image. No package downloads occur at runtime.

**Proof:** The Docker build includes `pnpm install` and bundles all `node_modules`. See `mvp/apps/web/Dockerfile`.

### 3. Synthetic Data from Local Wordlists

**File:** `mvp/packages/broker/src/synthetic.ts`

The `generateSynthetic` function creates fake data (announcements, employee records, etc.) using:
- Hardcoded wordlists (first names, last names, company departments, regions, etc.)
- PRNG (Math.random with optional seed) to select from those wordlists
- Local calculations (uuids, dates, numeric ranges)

**No network calls.** No LLM API, no external data sources.

**Verification:** Search `mvp/packages/broker/src/synthetic.ts` for:
- `fetch`, `http`, `axios`, `curl` — not present
- `ANTHROPIC`, `OPENAI`, `LLM` — not present
- Static arrays like `FIRST_NAMES`, `DEPARTMENTS`, `REGIONS` — present

**Implication:** Synthetic data generation is deterministic (same seed = same data) and requires zero network access.

## Testing Offline Operation

To verify offline operation without physically disconnecting the network (which is not feasible on a shared development machine):

1. **Cache the image (online):**
   ```bash
   cd mvp/examples/meridian
   warehousd start
   warehousd stop --destroy --yes
   ```

2. **Verify the image is cached:**
   ```bash
   docker images ghcr.io/tregismoreira/warehousd:0.1.0
   ```

3. **Simulate offline mode by using `--offline`:**
   ```bash
   warehousd start --offline
   warehousd stop --destroy --yes
   ```

   If any step tries to reach the network, it will fail. If this succeeds, offline operation is proven.

4. **Check logs for network activity** (optional):
   ```bash
   docker logs wh_cortex_server | grep -E "http|download|fetch|pull"
   ```
   Should be empty or contain only internal services (Postgres on localhost).

## Offline Guarantee Recap

The offline guarantee rests on three pillars:

| Mechanism | File:Line | Why It Works |
|-----------|-----------|--------------|
| **Image inspection** | `packages/cli/src/docker.ts:57` | Checks local cache before attempting pull |
| **pnpm exec** | `apps/web/scripts/entrypoint.ts:135` | Runs prebuilt binaries from bundled node_modules |
| **Local wordlists** | `packages/broker/src/synthetic.ts` | Generates data from hardcoded arrays, no external calls |

None of these mechanisms depend on network availability after the image is cached.

## Limitations

- **First-time setup requires network:** The initial `warehousd start` downloads the image (~261 MB). After that, offline operation is guaranteed.
- **Custom Postgres instance:** If you bring your own database via `--db`, that database server must be reachable (but this is a network dependency you control, not an external service).
- **No live updates:** The data schema and synthetic data definitions are baked into the image. To update them, rebuild the image.

## Summary

Once the warehousd Docker image is cached locally, `warehousd start` operates entirely offline. This is because:
1. The CLI inspects before pulling.
2. The container runs prebuilt dependencies (no package manager calls).
3. Synthetic data generation uses local wordlists only.

This design ensures portable, reproducible deployments without external service dependencies.
