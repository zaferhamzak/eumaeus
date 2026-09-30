# Eumaeus API + worker (one image, two processes: see deploy/docker-compose.yml).
# Build from the repository root:  docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter api...
COPY apps/api apps/api
RUN pnpm --filter api exec prisma generate && pnpm --filter api build
# A self-contained copy with production dependencies only.
RUN pnpm --filter api deploy --prod --legacy /out \
 && cp -r apps/api/dist /out/dist \
 && cp -r apps/api/prisma /out/prisma \
 && cd /out && npx prisma generate

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
COPY apps/api/docker-entrypoint.sh /usr/local/bin/eumaeus-entrypoint
RUN chmod +x /usr/local/bin/eumaeus-entrypoint && chown -R node:node /app
USER node
EXPOSE 3000
ENTRYPOINT ["eumaeus-entrypoint"]
CMD ["api"]
