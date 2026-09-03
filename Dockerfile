# ============================================
# AgentBridge API — production image
# ============================================
# Multi-stage so the runtime image carries no TypeScript, no dev dependencies
# and no source. Railway, Render and Fly all build this directly.
#
# The API is a long-running Fastify process, which is exactly why it belongs on
# a container platform rather than a serverless one: the janitor interval, the
# in-process rate limiter and the persistent connection pool all assume a
# process that stays alive between requests.

# ---- Build ----
FROM node:20-slim AS build

# Prisma needs OpenSSL to pick the right query engine.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so the dependency layer caches independently of source.
COPY package.json package-lock.json ./
COPY packages/shared-types/package.json    packages/shared-types/
COPY packages/policy-engine/package.json   packages/policy-engine/
COPY packages/threat-analyzer/package.json packages/threat-analyzer/
COPY packages/audit/package.json           packages/audit/
COPY packages/payments/package.json        packages/payments/
COPY apps/api/package.json                 apps/api/
COPY apps/mcp/package.json                 apps/mcp/
COPY apps/web/package.json                 apps/web/

RUN npm ci

COPY tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/

# Target Postgres before generating the client — the committed default is
# SQLite for local zero-setup development.
RUN npm run db:use:postgres --workspace=@agentbridge/api

# Packages compile to dist/ and the API consumes that compiled output, so the
# order matters and is explicit rather than left to npm's workspace ordering.
RUN npm run build:packages \
    && npm run build --workspace=@agentbridge/api

# ---- Runtime ----
FROM node:20-slim AS runtime

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared-types/package.json    packages/shared-types/
COPY packages/policy-engine/package.json   packages/policy-engine/
COPY packages/threat-analyzer/package.json packages/threat-analyzer/
COPY packages/audit/package.json           packages/audit/
COPY packages/payments/package.json        packages/payments/
COPY apps/api/package.json                 apps/api/

RUN npm ci --omit=dev --ignore-scripts

# Compiled output only — no .ts anywhere in the runtime image.
COPY --from=build /app/packages/shared-types/dist    packages/shared-types/dist
COPY --from=build /app/packages/policy-engine/dist   packages/policy-engine/dist
COPY --from=build /app/packages/threat-analyzer/dist packages/threat-analyzer/dist
COPY --from=build /app/packages/audit/dist           packages/audit/dist
COPY --from=build /app/packages/payments/dist        packages/payments/dist
COPY --from=build /app/apps/api/dist                 apps/api/dist

# Schema and migrations are needed at boot to run `prisma migrate deploy`.
COPY --from=build /app/apps/api/prisma                apps/api/prisma
# The generated Prisma client lives in the root node_modules of this workspace.
COPY --from=build /app/node_modules/.prisma           node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client    node_modules/@prisma/client

# Drop privileges. The node image ships an unprivileged `node` user.
USER node

EXPOSE 3001

# The platform injects PORT; config.ts honours it over API_PORT, and binds
# 0.0.0.0 in production so the platform router can reach the container.
WORKDIR /app/apps/api
CMD ["npm", "run", "start:migrate"]
