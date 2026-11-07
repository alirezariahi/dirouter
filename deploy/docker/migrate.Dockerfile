# syntax=docker/dockerfile:1.7
# اجرای یک‌بارهٔ `prisma migrate deploy` (سرویس migrate در compose).
ARG NODE_VERSION=22.17

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.10 prune @dirouter/db --docker

FROM base AS runtime
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@dirouter/db
COPY --from=prune /repo/out/full/packages/db/prisma ./packages/db/prisma
WORKDIR /repo/packages/db
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]
