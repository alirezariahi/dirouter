# syntax=docker/dockerfile:1.7
# Documentation site (card 22.5): Astro Starlight built from docs/, adr/ and the OpenAPI document,
# served by nginx-unprivileged.
ARG NODE_VERSION=22.17

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.10 prune @dirouter/docs --docker

FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY --from=prune /repo/out/full/ .
# The site's content lives outside its package.
COPY docs ./docs
COPY adr ./adr
COPY apps/dashboard/openapi.json ./apps/dashboard/openapi.json
RUN pnpm turbo run build --filter=@dirouter/docs

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
USER root
RUN apk upgrade --no-cache
USER 101
COPY deploy/docker/nginx/docs.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/docs/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
