# syntax=docker/dockerfile:1.7
# ایمیج مشترک اپ‌های Node (gateway، control-api، worker، mock-provider).
# build:  docker build -f deploy/docker/node.Dockerfile --build-arg APP=gateway .
ARG NODE_VERSION=22.17

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ۱) فقط فایل‌های لازم برای این اپ و وابستگی‌هایش.
FROM base AS prune
ARG APP
COPY . .
RUN pnpm dlx turbo@2.11.10 prune @dirouter/${APP} --docker

# ۲) نصب وابستگی‌ها (لایهٔ کش‌شونده) و build.
FROM base AS build
ARG APP
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@dirouter/${APP}
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@dirouter/${APP} deploy --prod --legacy /out

# ۳) ایمیج نهایی: alpine خالص + باینری node (بدون npm/yarn/corepack)، کاربر غیر root.
FROM node:${NODE_VERSION}-alpine AS node

FROM alpine:3.22 AS runtime
ARG APP
ARG PORT=8080
RUN apk add --no-cache libstdc++ tini \
    && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    PORT=${PORT} \
    APP=${APP}
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
EXPOSE ${PORT}
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
