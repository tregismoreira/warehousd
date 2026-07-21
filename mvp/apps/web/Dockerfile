FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false && pnpm --filter @warehousd/web build
EXPOSE 8722
# bootstrap is idempotent; safe on every start for the demo
CMD sh -c "pnpm tsx scripts/dev-bootstrap.ts && pnpm --filter @warehousd/web start"
