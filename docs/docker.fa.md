[English](docker.fa.md) · [فارسی](docker.fa.md)

<div dir="rtl">

# ایمیج‌های داکر

> فایل‌ها: `deploy/docker/*.Dockerfile`، `.dockerignore`. build: `make build` یا `docker build -f deploy/docker/node.Dockerfile --build-arg APP=gateway .`

## node.Dockerfile (gateway، control-api، worker، mock-provider)

یک Dockerfile مشترک با `--build-arg APP=<نام اپ>` و `PORT`:

1. **prune:** `turbo prune @dirouter/<APP> --docker` فقط فایل‌های همان اپ و پکیج‌های وابسته‌اش را جدا می‌کند (`out/json` برای نصب، `out/full` برای کد).
2. **build:** `pnpm install --frozen-lockfile` روی `out/json` (لایهٔ کش‌شونده؛ تغییر کد آن را باطل نمی‌کند، با cache mount برای store)، سپس `turbo run build --filter=@dirouter/<APP>` (شامل `prisma generate` برای db)، و `pnpm deploy --prod` فقط وابستگی‌های production را در `/out` می‌ریزد.
3. **runtime:** `alpine:3.22` + فقط باینری `node` (کپی از node:alpine، بدون npm/yarn/corepack) + `libstdc++` و `tini`.
   - کاربر غیر root: `node` با UID/GID ۱۰۰۰
   - `tini` به‌عنوان PID 1 (سیگنال‌ها و zombieها)
   - `HEALTHCHECK` روی `http://127.0.0.1:$PORT/healthz`
   - `NODE_ENV=production` و `--enable-source-maps`

## dashboard.Dockerfile

build استاتیک Vite و سرو با `nginxinc/nginx-unprivileged` (کاربر ۱۰۱، پورت ۸۰۸۰):

- SPA fallback (`try_files … /index.html`)
- gzip برای css/js/json/svg
- کش یک‌ساله و immutable برای `/assets/*` (نام فایل hash‌دار)، `no-cache` برای `index.html`
- `/config.js` در زمان اجرا از env کانتینر (`DIROUTER_API_URL`) ساخته می‌شود؛ یک ایمیج برای همهٔ محیط‌ها
- `/healthz` برای health check

## migrate.Dockerfile

ایمیج یک‌بارهٔ `prisma migrate deploy` (سرویس `migrate` در compose)؛ control-api و worker با `condition: service_completed_successfully` منتظرش می‌مانند. Prisma CLI به همین دلیل در ایمیج control-api نیست.

## dev.Dockerfile

فقط node + pnpm؛ کد با bind mount و `node_modules` در volumeهای نام‌دار (جدا از node_modules میزبان macOS) اجرا می‌شود (`compose.dev.yaml`).

## build چندمعماری

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f deploy/docker/node.Dockerfile --build-arg APP=gateway -t <registry>/gateway:<tag> --push .
```

## اندازه‌ها

(جدول پایین بعد از build اندازه‌گیری شده است.)

| ایمیج                 | حجم واقعی (filesystem) | فشرده (رجیستری) | کاربر |
| --------------------- | ---------------------- | --------------- | ----- |
| control-api           | 246MB                  | 67MB            | 1000  |
| gateway               | 161MB                  | 56MB            | 1000  |
| worker                | 141MB                  | 51MB            | 1000  |
| mock-provider         | ~145MB                 | —               | 1000  |
| dashboard             | 56MB                   | 23MB            | 101   |
| migrate (یک‌بار مصرف) | 602MB                  | 212MB           | 1000  |

نکته: `docker images` در Docker Desktop (containerd store) مجموع حجم unpack و فشرده را نشان می‌دهد و بزرگ‌تر از واقعی است؛ حجم واقعی با `docker run --rm --entrypoint sh <img> -c 'du -sxm /'` اندازه‌گیری شده است. حاشیهٔ control-api تا سقف ۲۵۰MB کم است (`swagger-ui-dist` و `es-toolkit` بزرگ‌ترین وابستگی‌های باقی‌مانده‌اند).

</div>
