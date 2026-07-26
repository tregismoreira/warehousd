# Build context is mvp/. See .dockerignore.
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @warehousd/web build

FROM node:22-slim AS runner
RUN npm install -g pnpm@10.33.0
WORKDIR /app
# node_modules is carried over intact rather than pruned: the entrypoint needs tsx and
# @better-auth/cli at runtime, and pruning them would break the offline bootstrap.
COPY --from=builder /app /app
ENV NODE_ENV=production \
    WAREHOUSD_PROJECT_DIR=/project \
    PORT=8722
EXPOSE 8722
VOLUME ["/project"]
# Bootstrap is idempotent and must complete before the server accepts traffic — `warehousd
# status` treats a 200 from /api/health as "bootstrapped", which only holds if these are
# sequential.
CMD ["sh", "-c", "pnpm tsx apps/web/scripts/entrypoint.ts && pnpm --filter @warehousd/web start"]
