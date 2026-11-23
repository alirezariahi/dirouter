# syntax=docker/dockerfile:1.7
# Portal (card 19.5): static build with Vite, served by nginx-unprivileged.
ARG NODE_VERSION=22.17

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.10 prune @dirouter/portal --docker

FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@dirouter/portal

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY deploy/docker/nginx/portal.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/portal/dist /usr/share/nginx/html
# The control-api and gateway addresses are injected into /config.js from env at runtime.
ENV DIROUTER_API_URL=/api \
    DIROUTER_GATEWAY_URL=
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
