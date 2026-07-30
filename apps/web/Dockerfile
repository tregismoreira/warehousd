# Build context is the repo root. See .dockerignore.
#
# Both stages pin node:22-slim by digest, not by tag. `node:22-slim` moves on every patch release,
# so the same Dockerfile built twice produced two different base images with no record of which —
# and a released image could not be reproduced. Dependabot's docker ecosystem entry keeps this
# current (see .github/dependabot.yml); the trailing comment says which tag the digest was.
FROM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS builder
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @warehousd/web build

FROM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS runner
RUN npm install -g pnpm@10.33.0
WORKDIR /app

# Named paths rather than `COPY --from=builder /app /app`, which carried the whole tree: the CLI
# package, the repo's tooling configs and every test file ended up in the published image with no
# runtime reading any of them.
#
# node_modules is still carried over intact rather than pruned, and that part is deliberate: the
# entrypoint runs under tsx and shells out to @better-auth/cli, both dev dependencies, so
# `--prod` here would break the offline bootstrap. That leaves dev dependencies in the production
# image — a known limitation rather than an oversight. Removing it means installing tsx and
# @better-auth/cli as runtime dependencies of apps/web, which is a change to the bootstrap's
# contract and wants its own verification pass.
#
# --chown on every copy: the runtime user below is not root, and a tree it cannot read is a
# container that starts and then cannot serve.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder --chown=node:node /app/packages/broker ./packages/broker
COPY --from=builder --chown=node:node /app/apps/web ./apps/web

ENV NODE_ENV=production \
    WAREHOUSD_PROJECT_DIR=/project \
    PORT=8722
EXPOSE 8722
VOLUME ["/project"]

# `node` (uid 1000) ships with the base image. Running as root gave every process in the container
# — including the config parser and the file indexer, both of which read attacker-influenced paths
# out of the mounted project directory — more than it needs.
#
# The cost is that /project must be readable by uid 1000 on Linux, where a bind mount keeps the
# host's ownership and mode. A 0755 directory — a git clone, or a `mkdir` under the usual umask —
# is fine; a 0700 one owned by another uid is not, and fails as "No warehousd.yml in /project"
# rather than as a permission error. Docker Desktop on macOS hides this by remapping ownership, so
# it only ever shows up on Linux.
USER node

# The same endpoint `warehousd status` polls: it answers 503 rather than throwing when Postgres is
# unreachable, so it reports the "process is up, database is gone" case this is for.
# start-period covers the bootstrap, which runs to completion before `next start` binds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8722/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Bootstrap is idempotent and must complete before the server accepts traffic — `warehousd
# status` treats a 200 from /api/health as "bootstrapped", which only holds if these are
# sequential.
CMD ["sh", "-c", "pnpm tsx apps/web/scripts/entrypoint.ts && pnpm --filter @warehousd/web start"]
