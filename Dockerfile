# Team Context Node runtime images.
#
# One build stage compiles the whole pnpm workspace once; each runtime target
# reuses that layer and differs only in its entrypoint. This keeps the API,
# worker and web surfaces provably built from the same revision, which is what
# makes a Team Context Node a single authority rather than three independently
# drifting deployments.
#
# Build a specific service with:
#   docker build --target api    -t akp-api .
#   docker build --target worker -t akp-worker .
#   docker build --target web    -t akp-web .

FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

# Dependency manifests first so an unchanged dependency graph reuses the
# install layer across source-only rebuilds.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/application/package.json packages/application/
COPY packages/audit-export/package.json packages/audit-export/
COPY packages/compiler/package.json packages/compiler/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/evaluation/package.json packages/evaluation/
COPY packages/git-store/package.json packages/git-store/
COPY packages/graph/package.json packages/graph/
COPY packages/indexing/package.json packages/indexing/
COPY packages/object-store/package.json packages/object-store/
COPY packages/observability/package.json packages/observability/
COPY packages/policy/package.json packages/policy/
COPY packages/postgres/package.json packages/postgres/
COPY packages/project-adapter/package.json packages/project-adapter/
COPY packages/retrieval/package.json packages/retrieval/
COPY packages/validation/package.json packages/validation/
COPY packages/vault-importer/package.json packages/vault-importer/
RUN pnpm install --frozen-lockfile

COPY . .

# The web login surface reads NEXT_PUBLIC_AKP_API_URL in the browser, so it is
# baked at build time and must be the address a developer's browser can reach —
# the node's published address, not its in-network compose name.
ARG NEXT_PUBLIC_AKP_API_URL=http://127.0.0.1:8080
ENV NEXT_PUBLIC_AKP_API_URL=$NEXT_PUBLIC_AKP_API_URL
RUN pnpm build


# Shared runtime base: a non-root user and the built workspace. git is present
# because governed publication writes through a managed git repository.
FROM node:24.20.0-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
# COPY --chown sets ownership on what it copies, not on the WORKDIR root that
# created /app. Without this the service user cannot write operational output
# such as reports/, and commands like `vault import` fail with EACCES.
RUN mkdir -p /app/reports && chown node:node /app /app/reports
USER node


FROM runtime AS api
# Containers reach this service over the bridge network, where a loopback bind
# would be unreachable. The default outside a container stays loopback-only.
ENV PORT=8080 \
    AKP_API_HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "apps/api/dist/apps/api/src/server.js"]


FROM runtime AS worker
CMD ["node", "apps/worker/dist/apps/worker/src/worker.js"]


FROM runtime AS web
ENV PORT=3000 \
    HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/web/.next/standalone/apps/web/server.js"]
