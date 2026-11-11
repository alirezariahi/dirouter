[English](docker.md) · [فارسی](docker.fa.md)

# Docker Images

> Files: `deploy/docker/*.Dockerfile`, `.dockerignore`. Build: `make build` or `docker build -f deploy/docker/node.Dockerfile --build-arg APP=gateway .`

## node.Dockerfile (gateway, control-api, worker, mock-provider)

One shared Dockerfile with `--build-arg APP=<app name>` and `PORT`:

1. **prune:** `turbo prune @dirouter/<APP> --docker` separates only the files of that app and its dependent packages (`out/json` for install, `out/full` for code).
2. **build:** `pnpm install --frozen-lockfile` on `out/json` (a cached layer; code changes do not invalidate it; uses a cache mount for the store), then `turbo run build --filter=@dirouter/<APP>` (including `prisma generate` for db), and `pnpm deploy --prod` puts only the production dependencies into `/out`.
3. **runtime:** `alpine:3.22` + only the `node` binary (copied from node:alpine, without npm/yarn/corepack) + `libstdc++` and `tini`.
   - non-root user: `node` with UID/GID 1000
   - `tini` as PID 1 (signals and zombie processes)
   - `HEALTHCHECK` on `http://127.0.0.1:$PORT/healthz`
   - `NODE_ENV=production` and `--enable-source-maps`

## dashboard.Dockerfile

Static Vite build served with `nginxinc/nginx-unprivileged` (user 101, port 8080):

- SPA fallback (`try_files … /index.html`)
- gzip for css/js/json/svg
- one-year immutable cache for `/assets/*` (hashed file names), `no-cache` for `index.html`
- `/config.js` is generated at runtime from the container's env (`DIROUTER_API_URL`); one image serves all environments
- `/healthz` for the health check

## migrate.Dockerfile

A one-off image that runs `prisma migrate deploy` (the `migrate` service in compose); control-api and worker wait for it with `condition: service_completed_successfully`. For this reason the Prisma CLI is not in the control-api image.

## dev.Dockerfile

Only node + pnpm; code runs through a bind mount, and `node_modules` lives in named volumes (separate from the macOS host's node_modules) (`compose.dev.yaml`).

## Multi-architecture build

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f deploy/docker/node.Dockerfile --build-arg APP=gateway -t <registry>/gateway:<tag> --push .
```

## Sizes

(The table below was measured after the build.)

| Image             | Actual size (filesystem) | Compressed (registry) | User |
| ----------------- | ------------------------ | --------------------- | ---- |
| control-api       | 246MB                    | 67MB                  | 1000 |
| gateway           | 161MB                    | 56MB                  | 1000 |
| worker            | 141MB                    | 51MB                  | 1000 |
| mock-provider     | ~145MB                   | —                     | 1000 |
| dashboard         | 56MB                     | 23MB                  | 101  |
| migrate (one-off) | 602MB                    | 212MB                 | 1000 |

Note: `docker images` in Docker Desktop (containerd store) shows the sum of the unpacked and compressed sizes, which is larger than the real size; the real size was measured with `docker run --rm --entrypoint sh <img> -c 'du -sxm /'`. The control-api margin under the 250MB ceiling is small (`swagger-ui-dist` and `es-toolkit` are the largest remaining dependencies).
