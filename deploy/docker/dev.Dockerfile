# Development image: code runs with a bind mount and hot-reload (compose.dev.yaml).
ARG NODE_VERSION=22.17
FROM node:${NODE_VERSION}-alpine
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CHOKIDAR_USEPOLLING=true
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /repo
