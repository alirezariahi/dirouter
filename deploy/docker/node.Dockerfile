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
# حذف چیزهایی که در زمان اجرا لازم نیستند (پنجرهٔ ۲۵۰MB):
# - peerهای اختیاری Prisma که pnpm نصب می‌کند (CLI، engines، typescript)
# - runtimeهای Prisma برای دیتابیس‌های دیگر، edge و source map (engineType=client فقط client.js + compiler postgresql)
# - همهٔ encodingهای js-tiktoken جز o200k_base
RUN cd /out/node_modules/.pnpm \
    && rm -rf typescript@* prisma@* @prisma+engines@* @prisma+config@* effect@* \
    && for d in @prisma+client@*/node_modules/@prisma/client/runtime; do \
         [ -d "$d" ] || continue; cd "$d"; \
         rm -f *.map query_engine_bg.* binary.* library.* edge* react-native* wasm-engine-edge* wasm-compiler-edge* index-browser*; \
         for db in cockroachdb mysql sqlite sqlserver; do rm -f query_compiler_bg.$db.*; done; \
         cd /out/node_modules/.pnpm; \
       done \
    && for d in js-tiktoken@*/node_modules/js-tiktoken/dist; do \
         [ -d "$d" ] || continue; rm -f "$d/index.js" "$d/index.cjs"; \
         find "$d/ranks" -type f ! -name 'o200k_base*' -delete; \
       done

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
