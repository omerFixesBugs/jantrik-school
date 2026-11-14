# syntax=docker/dockerfile:1
# Production images (docs/deploy.md). One file, three targets, built from the repo root:
#   api      the API (node dist/main.js). The same image runs the queue worker
#            (node dist/worker-main.js) and the device receiver (node dist/ingest-main.js).
#   web      the Next.js app (standalone server). NEXT_PUBLIC_API_URL is baked in at build time.
#   migrate  one shot, as the owner role: prisma migrate deploy, then the templates; also the
#            platform:admin CLI (node dist/cli/main.js).
# deploy/docker-compose.prod.yml builds and runs them.

# Keep in step with .nvmrc.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
# pnpm at the version in package.json ("packageManager").
RUN corepack enable
WORKDIR /repo

# Dependencies first, from the manifests only: this layer is rebuilt only when one of them changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/device-sim/package.json packages/device-sim/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/shared/package.json packages/shared/
COPY packages/typescript-config/package.json packages/typescript-config/
RUN --mount=type=cache,id=jantrik-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM deps AS source
COPY . .
RUN pnpm --filter @jantrik/db db:generate

# The API and the packages it uses, then a copy with production dependencies only.
FROM source AS build-api
RUN pnpm --filter "@jantrik/api..." run build
RUN --mount=type=cache,id=jantrik-pnpm-store,target=/pnpm/store \
    pnpm --filter @jantrik/api deploy --prod --store-dir /pnpm/store /out/api

# The db package with the Prisma CLI (a devDependency), the migrations and the CLIs.
FROM build-api AS build-migrate
RUN --mount=type=cache,id=jantrik-pnpm-store,target=/pnpm/store \
    pnpm --filter @jantrik/db deploy --store-dir /pnpm/store /out/db
RUN rm -rf /out/db/prisma /out/db/prisma.config.ts \
 && cp -r packages/db/prisma packages/db/prisma.config.ts /out/db/

# The web app as a standalone server. NEXT_PUBLIC_* values are inlined into the browser code here.
FROM source AS build-web
ARG NEXT_PUBLIC_API_URL
RUN test -n "$NEXT_PUBLIC_API_URL" \
 || (echo 'Set the build argument NEXT_PUBLIC_API_URL (e.g. https://api.example.com)' >&2 && exit 1)
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_OUTPUT=standalone
RUN pnpm --filter "@jantrik/web..." run build

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

FROM runtime AS api
WORKDIR /app
COPY --from=build-api --chown=root:root /out/api/package.json ./
COPY --from=build-api --chown=root:root /out/api/node_modules ./node_modules
COPY --from=build-api --chown=root:root /out/api/dist ./dist
USER node
EXPOSE 4000 4080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM runtime AS migrate
ENV CHECKPOINT_DISABLE=1
WORKDIR /app
COPY --from=build-migrate --chown=root:root /out/db ./
USER node
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/cli/seed-templates.js"]

FROM runtime AS web
WORKDIR /app
ENV PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build-web --chown=root:root /repo/apps/web/.next/standalone ./
COPY --from=build-web --chown=root:root /repo/apps/web/.next/static ./apps/web/.next/static
# Next's own cache is the only place the server writes to.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
