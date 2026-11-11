[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Environment Variable Reference

This document is the complete env contract for the `code/` source. Whenever you add, remove, or change an env consumer, update this document in the same change. The command `node scripts/ci/check-env-docs.mjs` (and the CI checks job) compares direct reads of `process.env` / `import.meta.env`, Zod schema keys, and Compose interpolations with the list below, and reports an error for a missing or removed item.

- **Required**: without a valid value, the boot fails or Compose cannot be rendered.
- **Default**: the value written is the code's or Compose's default; a fixed value inside Compose is marked separately.
- The values below are **examples, not real secrets**. Do not commit `.env`, and do not publish logs or public `config` output.
- In the Compose project, `.env` is read from the root of `code/`. Schedules and `_MS` intervals are in milliseconds.

## Base and app execution

| Variable    | Consumer                                    | Required? / default                                                                                      | Format and effect                                                                                                                              |
| ----------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`  | gateway, control-api, worker, mock-provider | app default `development`; Compose `production`                                                          | Only `development`, `test`, or `production`. In production the refresh cookie is created with `Secure`, and the development seed does not run. |
| `LOG_LEVEL` | all Node apps and some tests                | `info` in Compose/app; `debug` in the dev override                                                       | `fatal`, `error`, `warn`, `info`, `debug`, or `trace`. Logs are structured JSON; do not write keys or secrets into them.                       |
| `PORT`      | gateway, control-api, worker, mock-provider | `8787`, `3000`, `3100`, `8090` respectively; Compose injects `8080`, `3000`, `3100`, `8090` respectively | Integer from 1 to 65535; the listener port inside the process. Do not confuse the canary/mock port with Traefik's public port.                 |
| `HOSTNAME`  | worker maintenance job log                  | Docker provides the container's hostname                                                                 | Only for identifying the instance in logs; usually not set manually.                                                                           |
| `DATA_DIR`  | gateway                                     | `./.data`; Compose `/data`                                                                               | Path of the snapshot and the usage-event outbox. It must be on a persistent, writable volume.                                                  |

## Connections and shared secrets

| Variable               | Consumer                                                   | Required? / default                                              | Format and effect                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | control-api, worker, Prisma/migrate                        | Required                                                         | PostgreSQL connection URL. Compose builds it from `POSTGRES_*` with the internal host `postgres:5432`; for manual host or migrate runs, provide the full URL. URL-encode credentials that contain special characters.         |
| `VALKEY_URL`           | control-api and worker: required; gateway: optional        | No app default; Compose `redis://valkey:6379`                    | Valkey/Redis connection URL. Without it in the gateway, the usage queue, the distributed limiter, the heartbeat, and event sync are not active; always set it in production.                                                  |
| `MASTER_KEY`           | control-api, gateway, seed/dev-snapshot                    | Required; Compose rejects an empty value for gateway/control-api | AES-256-GCM keyring: `1:<base64-32-byte>`; several keys separated by commas with ascending versions: `1:<old>,2:<new>`. The highest version is used for new encryption. Keep old keys for decryption for as long as possible. |
| `KEY_PEPPER`           | control-api, gateway, seed/dev-snapshot                    | Required; at least 32 characters                                 | Pepper for the HMAC of virtual keys. An independent random value; changing it effectively invalidates all existing virtual keys.                                                                                              |
| `JWT_SECRET`           | control-api                                                | Required; at least 32 characters                                 | Signing secret for dashboard access tokens. Rotating it invalidates existing access sessions.                                                                                                                                 |
| `INTERNAL_TOKEN`       | control-api: required; gateway: optional in standalone run | At least 32 characters; required for both in Compose             | Bearer token for the internal snapshot, health, and probe paths. Both sides must be exactly identical.                                                                                                                        |
| `CONTROL_API_URL`      | gateway                                                    | Optional; Compose `http://control-api:3000`                      | Control-api origin for receiving the snapshot; in standalone mode without it, the gateway reads only the snapshot on disk.                                                                                                    |
| `GATEWAY_INTERNAL_URL` | control-api                                                | Default `http://gateway:8080`                                    | Internal gateway address for `/internal/health` and model/provider probes; the public `api.DOMAIN` endpoint is not needed.                                                                                                    |

## PostgreSQL and Compose

| Variable            | Consumer                                                    | Required? / default | Format and effect                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`     | PostgreSQL container and building `DATABASE_URL` in Compose | `dirouter`          | Database role/user name. Changing it on a volume that was created earlier does not change the existing user.                                                            |
| `POSTGRES_PASSWORD` | PostgreSQL and building `DATABASE_URL`                      | Required            | A strong random password; keep it in `.env`. For passwords containing `@`, `:`, or `/`, encode the final URL correctly, or use the hex password generated by bootstrap. |
| `POSTGRES_DB`       | PostgreSQL and building `DATABASE_URL`                      | `dirouter`          | Initial database name. Changing it on an existing volume does not rename the previous database.                                                                         |
| `POSTGRES_PORT`     | only `compose.dev.yaml`                                     | `55432`             | Publishes PostgreSQL on the host's `127.0.0.1`; in production no port is published.                                                                                     |
| `VALKEY_PORT`       | only `compose.dev.yaml`                                     | `56379`             | Publishes Valkey on the host's `127.0.0.1`; not published in production.                                                                                                |

## Dashboard and email

| Variable               | Consumer                                                                 | Required? / default                                                   | Format and effect                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DASHBOARD_ORIGIN`     | CORS in control-api and the fallback value for the public URL in Compose | App `https://app.localhost`; Compose `https://app.${DOMAIN}`          | The full dashboard origin without a trailing `/`; multiple origins separated by commas (in dev, HTTP/HTTPS). It must be exactly the browser origin, not a path.                                                           |
| `PUBLIC_DASHBOARD_URL` | Building invitation links in control-api                                 | App `https://app.localhost`; Compose takes it from `DASHBOARD_ORIGIN` | The public dashboard origin; links are built as `${PUBLIC_DASHBOARD_URL}/invite/<token>`. Compose takes its default from `DASHBOARD_ORIGIN`; if CORS has several origins, set it separately with a single-value override. |
| `DIROUTER_API_URL`     | Dashboard nginx, generating `/config.js` at runtime                      | Image `/api`; Compose `https://admin.${DOMAIN}/api/v1`                | The API address for the browser. This value is not secret and is injected into public JavaScript.                                                                                                                         |
| `VITE_API_URL`         | Dashboard build/dev                                                      | Optional                                                              | Fallback API address when `window.__DIROUTER__.apiUrl` is absent; used only at build/dev time by Vite. For production, use `DIROUTER_API_URL`.                                                                            |
| `SMTP_URL`             | control-api                                                              | Optional / empty                                                      | SMTP URL, such as `smtps://user:pass@smtp.example.com:465` or `smtp://…:587`. Empty means the invitation email is not sent, and the link is returned in the API response.                                                 |
| `SMTP_FROM`            | control-api                                                              | App `DiRouter <noreply@localhost>`; Compose based on `DOMAIN`         | The sender of invitation emails, with a display name and a valid address. In `.env`, quote a value that contains spaces.                                                                                                  |

## Edge, DNS and TLS

| Variable                  | Consumer                                  | Required? / default                                 | Format and effect                                                                                                                                                              |
| ------------------------- | ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOMAIN`                  | Traefik and Compose                       | `localhost`                                         | Base domain without scheme or path; the routes are `api.`, `admin.`, `app.`, and `traefik.`. Use `localhost` in dev.                                                           |
| `HTTP_PORT`               | Compose/Traefik                           | `80`                                                | Host HTTP port; HTTPS redirect and the HTTP-01 challenge. For ACME it normally must be 80.                                                                                     |
| `HTTPS_PORT`              | Compose/Traefik                           | `443`                                               | Host HTTPS port. If you change it, account for the port in DNS, URLs, the firewall, and client access.                                                                         |
| `ACME_EMAIL`              | Production Traefik configuration template | Operationally required in production; default empty | The Let's Encrypt account email; replaced in the static config at boot. Not a secret, but use a real, monitored address.                                                       |
| `TRAEFIK_VERSION`         | Traefik image                             | `v3.6`                                              | Traefik image tag; pin it and test upgrades.                                                                                                                                   |
| `TRAEFIK_DASHBOARD_USERS` | Traefik dashboard Basic Auth middleware   | Empty; effectively no valid user                    | Comma-separated htpasswd entries, such as `admin:$2y$…`. Do not write a plain password. `$` must be written as `$$` for Compose, and access should also be restricted by CIDR. |
| `TRAEFIK_ALLOW_IPS`       | Traefik dashboard IP allowlist middleware | `127.0.0.1/32`                                      | Allowed IPs or CIDRs, comma-separated. For a public production dashboard, give the VPN or admin value, or keep the router on a private network.                                |

## Monitoring

| Variable                 | Consumer                          | Required? / default                  | Format and effect                                                                                                                |
| ------------------------ | --------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GRAFANA_ADMIN_USER`     | Grafana in the monitoring profile | `admin`                              | Initial admin name, for signing in to Grafana locally.                                                                           |
| `GRAFANA_ADMIN_PASSWORD` | Grafana in the monitoring profile | Required when the profile is enabled | A strong, independent password with no default. Keep it in `.env`, and do not publish it in public Compose output or logs.       |
| `GRAFANA_PORT`           | Grafana port publishing           | `53000`                              | UI port on the host's `127.0.0.1`. For remote access, use a tunnel or a secure proxy.                                            |
| `GRAFANA_VERSION`        | Grafana image                     | `12.2.1`                             | Pinned tag; upgrade after checking the provisioning and dashboards.                                                              |
| `PROMETHEUS_PORT`        | Prometheus port publishing        | `59090`                              | UI/API port on the host's `127.0.0.1`.                                                                                           |
| `PROMETHEUS_RETENTION`   | TSDB in Prometheus                | `15d`                                | Retention period of the series, in Prometheus time units. Check the volume capacity against this value and the number of series. |
| `PROMETHEUS_VERSION`     | Prometheus image                  | `v3.7.3`                             | Pinned tag; validate the rules after an upgrade with `promtool check`.                                                           |

The run guide and security details are in [monitoring.md](monitoring.md).

## Release, scale and shutdown

| Variable                          | Consumer                                    | Required? / default                                     | Format and effect                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REGISTRY`                        | Compose image names                         | `dirouter`; `.env.example` shows the GHCR path          | Registry prefix/namespace without the app name and tag; for example `ghcr.io/acme/dirouter`. It must also cover the `migrate` image.                                                      |
| `TAG`                             | Compose image names                         | `latest`                                                | Shared tag for the apps and migrate. For production, use `sha-<full-commit>` or a SemVer published by CI; CI does not produce `latest`.                                                   |
| `GATEWAY_REPLICAS`                | `compose.prod.yaml`                         | `2`                                                     | Number of gateway replicas. This setting is compatible with Docker Compose/Swarm; in a plain `docker compose up`, it takes effect with `--scale` or by changing the value and recreating. |
| `GATEWAY_SHUTDOWN_DRAIN_MS`       | Compose → gateway `SHUTDOWN_DRAIN_MS`       | `30000`                                                 | The upper limit for waiting for requests and open streams to finish on SIGTERM; a non-negative integer.                                                                                   |
| `GATEWAY_SHUTDOWN_READY_DELAY_MS` | Compose → gateway `SHUTDOWN_READY_DELAY_MS` | `5000`                                                  | The pause after `/readyz` turns 503, until the replica is removed from Traefik; a non-negative integer and more than two health check cycles.                                             |
| `SHUTDOWN_DRAIN_MS`               | gateway (name inside the process)           | `30000`; usually fed from the prefixed Compose variable | The drain limit in a direct run. If you change it, make `stop_grace_period` larger than the ready delay + drain + flush time.                                                             |
| `SHUTDOWN_READY_DELAY_MS`         | gateway (name inside the process)           | `5000`; usually fed from the prefixed Compose variable  | The delay before leaving the readiness rotation in a direct run.                                                                                                                          |

## Worker and data retention

| Variable                       | Consumer           | Required? / default | Range and effect                                                                                                                         |
| ------------------------------ | ------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUEST_LOG_RETENTION_MONTHS` | worker and Compose | `3`                 | Integer from 1 to 120 months; fully old `request_log` partitions are removed daily at 03:17 UTC. The ledger and rollups are not deleted. |
| `USAGE_CONCURRENCY`            | worker/BullMQ      | `200`               | Integer from 1 to 2000; concurrency of usage jobs. Increasing it adds load on Postgres and Valkey.                                       |
| `USAGE_BATCH_SIZE`             | worker             | `500`               | Integer from 1 to 5000; the maximum number of events in one write batch.                                                                 |
| `USAGE_FLUSH_MS`               | worker             | `200`               | Integer from 10 to 10000; the maximum pause before a batch flush, for balancing latency and throughput.                                  |
| `ROLLUP_INTERVAL_MS`           | worker             | `30000`             | Integer, at least 1000; the interval of the hourly/daily aggregation scheduler.                                                          |
| `DB_MAX_CONNECTIONS`           | worker/Prisma      | `10`                | Integer, at least 1; the DB connection pool limit for each worker. Control the total number of connections against the Postgres limit.   |

## Development tools and mock

| Variable                | Consumer                            | Required? / default           | Format and effect                                                                                                                                                                      |
| ----------------------- | ----------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOCK_DEFAULT`          | mock-provider                       | Optional                      | The default directive of the mock scenario (for example `status=503`). Test and development only; in production, mock-provider runs outside the default run, under the `mock` profile. |
| `MAILPIT_UI_PORT`       | dev Compose/Mailpit only            | `58025`                       | UI port on `127.0.0.1`; this is not real production email data.                                                                                                                        |
| `SEED_MOCK_URL`         | only `apps/control-api/src/seed.ts` | `http://mock-provider:8090`   | The origin of the mock provider during the development seed.                                                                                                                           |
| `SEED_CREDENTIALS_FILE` | development seed only               | `/repo/.data/seed-admin.env`  | Path of a 0600 file that contains the initial admin password; outside Git and on a secure disk.                                                                                        |
| `SEED_ADMIN_PASSWORD`   | development seed only               | Random if no value is given   | The development admin password, used only when creating the user; never use it for production or the seed.                                                                             |
| `DEV_API_KEY`           | only `scripts/dev-snapshot.mjs`     | Fixed dev value in the script | The test key for the local snapshot; not a production secret, and not a path for production bootstrap.                                                                                 |

## CI and integration tests (not production settings)

These names are documented for automatic and local CI runs so that the env reference remains complete. You do not need them in the production `.env`.

| Variable                    | Consumer                                                                     | Required? / default                     | Purpose                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `CI`                        | Performance test threshold in `packages/routing` and the Actions environment | GitHub sets it to `true`                | On a shared runner, it loosens the fluctuating route-test threshold; it does not change the production app's behavior. |
| `INTEGRATION_DATABASE_URL`  | control-api/worker integration tests                                         | Without it, the related part is skipped | The URL of an isolated test database; never the production database.                                                   |
| `INTEGRATION_VALKEY_URL`    | gateway/control-api/worker integration tests                                 | Without it, the related part is skipped | The URL of an isolated test Valkey.                                                                                    |
| `INTEGRATION_DATABASE_NAME` | `scripts/ci/services.integration.mjs` and the integration runner             | `dirouter_ci`                           | The test database name inside the container, for running psql correctly.                                               |
| `POSTGRES_CONTAINER`        | CI infrastructure smoke test                                                 | Required for that script                | The ID or name of the isolated PostgreSQL container; in the workflow, it comes from the service ID.                    |
| `VALKEY_CONTAINER`          | CI infrastructure smoke test                                                 | Required for that script                | The ID or name of the isolated Valkey container.                                                                       |
| `GITHUB_EVENT_PATH`         | `scripts/ci/plan.mjs`                                                        | GitHub Actions                          | The path to the event JSON, used to find the base SHA.                                                                 |
| `GITHUB_EVENT_NAME`         | `scripts/ci/plan.mjs`                                                        | GitHub Actions                          | The event type: push, PR, or manual, used to select the scope.                                                         |
| `GITHUB_REF`                | `scripts/ci/plan.mjs`                                                        | GitHub Actions                          | The current ref; used to validate the release tag.                                                                     |
| `GITHUB_SHA`                | `scripts/ci/plan.mjs`                                                        | GitHub Actions                          | The head SHA for the diff and package selection.                                                                       |
| `GITHUB_OUTPUT`             | `scripts/ci/plan.mjs`                                                        | GitHub Actions                          | The step output file for the filter and matrix.                                                                        |
| `GITHUB_STEP_SUMMARY`       | `scripts/ci/plan.mjs`                                                        | GitHub Actions                          | The file for the CI run summary.                                                                                       |
| `TURBO_TELEMETRY_DISABLED`  | CI/Turborepo environment                                                     | The workflow sets it to `1`             | Disables the build tool's telemetry; it is not read by the app code.                                                   |
| `HUSKY`                     | CI installation                                                              | The setup sets it to `0`                | Disables the hooks during installation on the runner; it is not read by the app code.                                  |
| `REPOSITORY`                | CI image naming step                                                         | From the GitHub context                 | The repository name, used to build the lowercase GHCR name; a workflow-local variable.                                 |
| `APP`                       | CI image naming step                                                         | From the GitHub matrix                  | The app name for the GHCR image; a workflow-local variable, not the app's run configuration.                           |
| `TURBO_FILTER`              | Package check step                                                           | Output of the `plan` job                | The Turbo filter that selects the changed packages and their dependents.                                               |
| `PLAN`                      | Final `CI passed` step                                                       | Result of the plan job                  | A status string that prevents a cumulative success when a job has failed.                                              |
| `CHECKS`                    | Final `CI passed` step                                                       | Result of the checks job                | The status of lint/typecheck/test/build; it must be `success`.                                                         |
| `INTEGRATION`               | Final `CI passed` step                                                       | Result of the integration job           | The integration test status; depending on the package selection, it must be `success` or `skipped`.                    |
| `IMAGES`                    | Final `CI passed` step                                                       | Result of the images job                | The build/publish status of the images; depending on the matrix, it must be `success` or `skipped`.                    |
| `HAS_PACKAGES`              | Final `CI passed` step                                                       | Output of plan                          | Determines whether the integration job is required or must be skipped.                                                 |
| `HAS_IMAGES`                | Final `CI passed` step                                                       | Output of plan                          | Determines whether the image job is required or must be skipped.                                                       |

### End-to-end test addresses

| Variable          | Consumer                   | Default                  | Description                                                       |
| ----------------- | -------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `E2E_GATEWAY_URL` | `scripts/e2e/sprint-1.mjs` | `http://api.localhost`   | The gateway entry behind Traefik in an isolated test environment. |
| `E2E_ADMIN_URL`   | `scripts/e2e/sprint-1.mjs` | `http://admin.localhost` | The control-api entry, for building fixtures and checking status. |
| `E2E_MOCK_URL`    | `scripts/e2e/sprint-1.mjs` | `http://mock.localhost`  | The mock-provider entry, for injecting errors.                    |

This suite deliberately stops services. Run it only on a dedicated development or test environment, never in production.

## Safe separation and least privilege

- `MASTER_KEY`, `KEY_PEPPER`, `JWT_SECRET`, `INTERNAL_TOKEN`, `POSTGRES_PASSWORD`, `DATABASE_URL`, and `SMTP_URL` are secrets or contain secrets.
- The gateway needs only `MASTER_KEY`, `KEY_PEPPER`, `INTERNAL_TOKEN`, `VALKEY_URL`, and the control-api address; **not `DATABASE_URL`**.
- The worker needs Postgres and Valkey, and does not need the JWT, master, or internal secrets.
- Provider secrets are encrypted in the database and entered from the dashboard; do not put them in the env. A DNS-01 secret (such as `CF_DNS_API_TOKEN`) is given to Traefik only when that challenge is enabled, and it is not part of the app contract.

---

<a id="persian"></a>

# مرجع متغیرهای محیطی

این سند قرارداد کامل env در سورس `code/` است. هر بار افزودن/حذف/تغییر مصرف‌کنندهٔ env، این سند را همان‌جا به‌روزرسانی کنید. دستور `node scripts/ci/check-env-docs.mjs` (و job بررسی‌های CI) خواندن مستقیم `process.env`/`import.meta.env`، کلیدهای اسکیمای Zod و interpolationهای Compose را با فهرست زیر مقایسه می‌کند و روی مورد جاافتاده یا حذف‌شده خطا می‌دهد.

- **الزامی**: بدون مقدار معتبر بوت ناموفق است یا Compose را نمی‌توان render کرد.
- **پیش‌فرض**: مقدار نوشته‌شده پیش‌فرض کد یا Compose است؛ مقدار ثابت داخل Compose جدا مشخص شده است.
- مقادیر زیر **نمونه‌اند، نه راز واقعی**. `.env` را commit نکنید و لاگ/خروجی `config` عمومی را منتشر نکنید.
- در Compose پروژه، `.env` در ریشهٔ `code/` خوانده می‌شود. زمان‌بندی‌ها و بازه‌های `_MS` بر حسب میلی‌ثانیه‌اند.

## پایه و اجرای اپ‌ها

| متغیر       | مصرف‌کننده                                  | لازم؟ / پیش‌فرض                                                                                       | قالب و اثر                                                                                                                |
| ----------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`  | gateway، control-api، worker، mock-provider | پیش‌فرض اپ `development`، Compose `production`                                                        | فقط `development`، `test` یا `production`. در production کوکی refresh با `Secure` ساخته می‌شود و seed توسعه اجرا نمی‌شود. |
| `LOG_LEVEL` | همهٔ اپ‌های Node و برخی تست‌ها              | `info` در Compose/اپ؛ `debug` در dev override                                                         | `fatal`، `error`، `warn`، `info`، `debug` یا `trace`. لاگ JSON ساخت‌یافته است؛ کلید/راز در آن ننویسید.                    |
| `PORT`      | gateway، control-api، worker، mock-provider | به‌ترتیب `8787`، `3000`، `3100`، `8090`؛ Compose به‌ترتیب `8080`، `3000`، `3100`، `8090` تزریق می‌کند | عدد صحیح ۱ تا ۶۵۵۳۵؛ پورت listener داخل پروسه. پورت canary/mock را با پورت عمومی Traefik اشتباه نگیرید.                   |
| `HOSTNAME`  | لاگ job نگهداری worker                      | Docker مقدار hostname کانتینر را می‌دهد                                                               | فقط برای مشخص‌کردن instance در لاگ است؛ معمولاً دستی تنظیم نمی‌شود.                                                       |
| `DATA_DIR`  | gateway                                     | `./.data`؛ Compose `/data`                                                                            | مسیر snapshot و outbox رویداد مصرف. باید روی volume پایدار و قابل نوشتن باشد.                                             |

## اتصال‌ها و رازهای مشترک

| متغیر                  | مصرف‌کننده                                                | لازم؟ / پیش‌فرض                                             | قالب و اثر                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | control-api، worker، Prisma/migrate                       | الزامی                                                      | URL اتصال PostgreSQL. Compose آن را از `POSTGRES_*` با host داخلی `postgres:5432` می‌سازد؛ برای اجرای host/migrate دستی URL کامل بدهید. credential دارای کاراکتر خاص را URL-encode کنید. |
| `VALKEY_URL`           | control-api و worker: الزامی؛ gateway: اختیاری            | بدون پیش‌فرض اپ؛ Compose `redis://valkey:6379`              | URL اتصال Valkey/Redis. بدون آن در gateway، صف usage، limiter توزیع‌شده، heartbeat و sync رویدادها فعال نیست؛ برای production حتماً تنظیم شود.                                           |
| `MASTER_KEY`           | control-api، gateway، seed/dev-snapshot                   | الزامی؛ Compose مقدار خالی gateway/control-api را رد می‌کند | keyring AES-256-GCM: `1:<base64-32-byte>`؛ چند کلید با ویرگول و نسخه‌های صعودی: `1:<old>,2:<new>`. بالاترین نسخه برای رمزنگاری جدید است. کلیدهای قدیمی را تا امکان decrypt نگه دارید.    |
| `KEY_PEPPER`           | control-api، gateway، seed/dev-snapshot                   | الزامی؛ حداقل ۳۲ کاراکتر                                    | pepper برای HMAC کلیدهای مجازی. مقدار تصادفی مستقل؛ تغییر آن همهٔ کلیدهای مجازی موجود را از نظر عملی باطل می‌کند.                                                                        |
| `JWT_SECRET`           | control-api                                               | الزامی؛ حداقل ۳۲ کاراکتر                                    | راز امضای access token داشبورد. چرخش آن نشست‌های access موجود را نامعتبر می‌کند.                                                                                                         |
| `INTERNAL_TOKEN`       | control-api: الزامی؛ gateway: اختیاری در اجرای standalone | حداقل ۳۲ کاراکتر؛ در Compose برای هر دو لازم                | Bearer token مسیرهای داخلی snapshot، health و probe. هر دو سمت باید دقیقاً یکسان باشند.                                                                                                  |
| `CONTROL_API_URL`      | gateway                                                   | اختیاری؛ Compose `http://control-api:3000`                  | مبدأ control-api برای دریافت snapshot؛ در standalone بدون آن، gateway فقط snapshot روی دیسک را می‌خواند.                                                                                 |
| `GATEWAY_INTERNAL_URL` | control-api                                               | پیش‌فرض `http://gateway:8080`                               | آدرس داخلی gateway برای `/internal/health` و probe مدل/provider؛ endpoint عمومی `api.DOMAIN` لازم نیست.                                                                                  |

## PostgreSQL و Compose

| متغیر               | مصرف‌کننده                                          | لازم؟ / پیش‌فرض | قالب و اثر                                                                                                                              |
| ------------------- | --------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`     | کانتینر PostgreSQL و ساخت `DATABASE_URL` در Compose | `dirouter`      | نام نقش/کاربر دیتابیس. تغییر آن روی volumeای که از قبل ساخته شده، کاربر موجود را عوض نمی‌کند.                                           |
| `POSTGRES_PASSWORD` | PostgreSQL و ساخت `DATABASE_URL`                    | الزامی          | رمز قوی تصادفی؛ در `.env` نگه دارید. برای رمزهای دارای `@`/`:`/`/`، URL نهایی را درست encode کنید یا از رمز hex bootstrap استفاده کنید. |
| `POSTGRES_DB`       | PostgreSQL و ساخت `DATABASE_URL`                    | `dirouter`      | نام دیتابیس اولیه. تغییر روی volume موجود، دیتابیس قبلی را rename نمی‌کند.                                                              |
| `POSTGRES_PORT`     | فقط `compose.dev.yaml`                              | `55432`         | انتشار PostgreSQL روی `127.0.0.1` میزبان؛ در production پورتی منتشر نمی‌شود.                                                            |
| `VALKEY_PORT`       | فقط `compose.dev.yaml`                              | `56379`         | انتشار Valkey روی `127.0.0.1` میزبان؛ در production منتشر نمی‌شود.                                                                      |

## داشبورد و ایمیل

| متغیر                  | مصرف‌کننده                                                     | لازم؟ / پیش‌فرض                                             | قالب و اثر                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DASHBOARD_ORIGIN`     | CORS در control-api و مقدار fallback برای URL عمومی در Compose | اپ `https://app.localhost`؛ Compose `https://app.${DOMAIN}` | Origin کامل داشبورد بدون `/` آخر؛ چند origin با ویرگول (در dev HTTP/HTTPS). باید دقیقاً origin مرورگر باشد، نه path.                                                                                          |
| `PUBLIC_DASHBOARD_URL` | ساخت لینک دعوت در control-api                                  | اپ `https://app.localhost`؛ Compose از `DASHBOARD_ORIGIN`   | مبدأ عمومی داشبورد؛ لینک به شکل `${PUBLIC_DASHBOARD_URL}/invite/<token>` ساخته می‌شود. Compose پیش‌فرض آن را از `DASHBOARD_ORIGIN` می‌گیرد؛ اگر CORS چند origin دارد، با override جدا و تک‌مقدار تنظیمش کنید. |
| `DIROUTER_API_URL`     | nginx داشبورد، تولید `/config.js` در runtime                   | image `/api`؛ Compose `https://admin.${DOMAIN}/api/v1`      | آدرس API برای مرورگر. این مقدار محرمانه نیست و به جاوااسکریپت عمومی تزریق می‌شود.                                                                                                                             |
| `VITE_API_URL`         | build/dev داشبورد                                              | اختیاری                                                     | fallback آدرس API وقتی `window.__DIROUTER__.apiUrl` نباشد؛ فقط زمان build/dev توسط Vite. برای production از `DIROUTER_API_URL` استفاده کنید.                                                                  |
| `SMTP_URL`             | control-api                                                    | اختیاری/خالی                                                | URL SMTP، مثل `smtps://user:pass@smtp.example.com:465` یا `smtp://…:587`. خالی یعنی ایمیل دعوت ارسال نمی‌شود و لینک در پاسخ API برمی‌گردد.                                                                    |
| `SMTP_FROM`            | control-api                                                    | اپ `DiRouter <noreply@localhost>`؛ Compose بر اساس `DOMAIN` | فرستندهٔ ایمیل دعوت، با نام نمایشی و نشانی معتبر. در `.env` مقدار دارای فاصله را quote کنید.                                                                                                                  |

## لبه، DNS و TLS

| متغیر                     | مصرف‌کننده                              | لازم؟ / پیش‌فرض                              | قالب و اثر                                                                                                                                     |
| ------------------------- | --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                  | Traefik و Compose                       | `localhost`                                  | دامنهٔ پایه بدون scheme/path؛ مسیرها: `api.`، `admin.`، `app.` و `traefik.`. در dev از `localhost` استفاده شود.                                |
| `HTTP_PORT`               | Compose/Traefik                         | `80`                                         | پورت HTTP میزبان؛ ریدایرکت HTTPS و HTTP-01 challenge. برای ACME معمولاً باید 80 باشد.                                                          |
| `HTTPS_PORT`              | Compose/Traefik                         | `443`                                        | پورت HTTPS میزبان. اگر تغییرش دهید، پورت را در DNS/URL/فایروال و دسترسی کلاینت لحاظ کنید.                                                      |
| `ACME_EMAIL`              | template پیکربندی production Traefik    | در production لازم عملیاتی است؛ پیش‌فرض خالی | ایمیل حساب Let's Encrypt؛ هنگام boot در static config جایگزین می‌شود. راز نیست، ولی ایمیل واقعی و پایش‌شده بدهید.                              |
| `TRAEFIK_VERSION`         | image Traefik                           | `v3.6`                                       | تگ image Traefik؛ آن را pin و ارتقاها را آزمایش کنید.                                                                                          |
| `TRAEFIK_DASHBOARD_USERS` | middleware Basic Auth داشبورد Traefik   | خالی؛ عملاً هیچ کاربر معتبری ندارد           | ورودی‌های htpasswd جداشده با ویرگول، مثل `admin:$2y$…`. رمز عادی ننویسید. `$`ها برای Compose باید `$$` شوند و دسترسی را با CIDR هم محدود کنید. |
| `TRAEFIK_ALLOW_IPS`       | middleware IP allowlist داشبورد Traefik | `127.0.0.1/32`                               | IP/CIDRهای مجاز، جداشده با ویرگول. برای داشبورد عمومی production مقدار مناسب VPN/مدیر بدهید یا router را در شبکهٔ خصوصی نگه دارید.             |

## مانیتورینگ

| متغیر                    | مصرف‌کننده                    | لازم؟ / پیش‌فرض                | قالب و اثر                                                                                            |
| ------------------------ | ----------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `GRAFANA_ADMIN_USER`     | Grafana در پروفایل monitoring | `admin`                        | نام مدیر اولیه؛ برای ورود محلی به Grafana.                                                            |
| `GRAFANA_ADMIN_PASSWORD` | Grafana در پروفایل monitoring | الزامی هنگام فعال‌کردن پروفایل | رمز قوی مستقل و بدون پیش‌فرض. در `.env` نگه دارید و آن را در خروجی عمومی Compose یا لاگ منتشر نکنید.  |
| `GRAFANA_PORT`           | انتشار پورت Grafana           | `53000`                        | پورت UI روی `127.0.0.1` میزبان. برای دسترسی راه دور از tunnel یا proxy امن استفاده کنید.              |
| `GRAFANA_VERSION`        | image Grafana                 | `12.2.1`                       | تگ pin‌شده؛ ارتقا را با بررسی provisioning و داشبورد انجام دهید.                                      |
| `PROMETHEUS_PORT`        | انتشار پورت Prometheus        | `59090`                        | پورت UI/API روی `127.0.0.1` میزبان.                                                                   |
| `PROMETHEUS_RETENTION`   | TSDB در Prometheus            | `15d`                          | مدت نگهداری سری‌ها، با واحد زمانی Prometheus. ظرفیت volume را متناسب با مقدار و تعداد سری بررسی کنید. |
| `PROMETHEUS_VERSION`     | image Prometheus              | `v3.7.3`                       | تگ pin‌شده؛ قواعد را پس از ارتقا با `promtool check` اعتبارسنجی کنید.                                 |

راهنمای اجرا و جزئیات امنیتی در [monitoring.md](monitoring.md) است.

## انتشار، مقیاس و خاموشی

| متغیر                             | مصرف‌کننده                                 | لازم؟ / پیش‌فرض                                           | قالب و اثر                                                                                                                                                 |
| --------------------------------- | ------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REGISTRY`                        | نام imageهای Compose                       | `dirouter`؛ `.env.example` مسیر GHCR را نشان می‌دهد       | پیشوند registry/namespace بدون نام اپ و تگ؛ مثلاً `ghcr.io/acme/dirouter`. باید شامل image `migrate` هم باشد.                                              |
| `TAG`                             | نام imageهای Compose                       | `latest`                                                  | تگ مشترک اپ‌ها و migrate. برای production از `sha-<full-commit>` یا SemVer منتشرشدهٔ CI استفاده کنید؛ `latest` را CI تولید نمی‌کند.                        |
| `GATEWAY_REPLICAS`                | `compose.prod.yaml`                        | `2`                                                       | تعداد replicaهای gateway. این تنظیم با Docker Compose/Swarm سازگار است؛ در `docker compose up` معمولی با `--scale` یا تغییر مقدار و recreate اعمال می‌شود. |
| `GATEWAY_SHUTDOWN_DRAIN_MS`       | Compose → `SHUTDOWN_DRAIN_MS` گیت‌وی       | `30000`                                                   | سقف انتظار برای پایان درخواست/streamهای باز هنگام SIGTERM؛ عدد صحیح نامنفی.                                                                                |
| `GATEWAY_SHUTDOWN_READY_DELAY_MS` | Compose → `SHUTDOWN_READY_DELAY_MS` گیت‌وی | `5000`                                                    | مکث بعد از 503 شدن `/readyz` تا خارج‌شدن replica از Traefik؛ عدد صحیح نامنفی و بیشتر از دو دور health check.                                               |
| `SHUTDOWN_DRAIN_MS`               | gateway (نام داخل پروسه)                   | `30000`؛ معمولاً از متغیر prefix‌دار Compose تغذیه می‌شود | سقف drain در اجرای مستقیم. اگر تغییر دهید، `stop_grace_period` را بزرگ‌تر از delay + drain + زمان flush کنید.                                              |
| `SHUTDOWN_READY_DELAY_MS`         | gateway (نام داخل پروسه)                   | `5000`؛ معمولاً از متغیر prefix‌دار Compose تغذیه می‌شود  | تأخیر خروج از چرخش readiness در اجرای مستقیم.                                                                                                              |

## worker و نگهداری داده

| متغیر                          | مصرف‌کننده       | لازم؟ / پیش‌فرض | محدوده و اثر                                                                                                        |
| ------------------------------ | ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `REQUEST_LOG_RETENTION_MONTHS` | worker و Compose | `3`             | عدد صحیح ۱ تا ۱۲۰ ماه؛ حذف پارتیشن‌های کاملاً قدیمی `request_log` روزانه 03:17 UTC. ledger و rollupها حذف نمی‌شوند. |
| `USAGE_CONCURRENCY`            | worker/BullMQ    | `200`           | عدد صحیح ۱ تا ۲۰۰۰؛ هم‌زمانی مصرف jobهای usage. افزایش آن بار Postgres/Valkey را بیشتر می‌کند.                      |
| `USAGE_BATCH_SIZE`             | worker           | `500`           | عدد صحیح ۱ تا ۵۰۰۰؛ حداکثر رویداد در دستهٔ نوشتن.                                                                   |
| `USAGE_FLUSH_MS`               | worker           | `200`           | عدد صحیح ۱۰ تا ۱۰۰۰۰؛ حداکثر مکث flush دسته، برای توازن latency/throughput.                                         |
| `ROLLUP_INTERVAL_MS`           | worker           | `30000`         | عدد صحیح حداقل ۱۰۰۰؛ فاصلهٔ scheduler تجمیع ساعتی/روزانه.                                                           |
| `DB_MAX_CONNECTIONS`           | worker/Prisma    | `10`            | عدد صحیح حداقل ۱؛ سقف pool اتصال DB برای هر worker. مجموع اتصال‌ها را با سقف Postgres کنترل کنید.                   |

## ابزار توسعه و mock

| متغیر                   | مصرف‌کننده                         | لازم؟ / پیش‌فرض              | قالب و اثر                                                                                                                                 |
| ----------------------- | ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MOCK_DEFAULT`          | mock-provider                      | اختیاری                      | directive پیش‌فرض سناریوی mock (مثل `status=503`). فقط تست/توسعه؛ mock-provider در production با profile `mock` خارج از اجرای پیش‌فرض است. |
| `MAILPIT_UI_PORT`       | فقط dev Compose/Mailpit            | `58025`                      | پورت UI روی `127.0.0.1`؛ دادهٔ ایمیل واقعی production نیست.                                                                                |
| `SEED_MOCK_URL`         | فقط `apps/control-api/src/seed.ts` | `http://mock-provider:8090`  | مبدأ mock provider هنگام seed توسعه.                                                                                                       |
| `SEED_CREDENTIALS_FILE` | فقط seed توسعه                     | `/repo/.data/seed-admin.env` | مسیر فایل 0600 حاوی رمز مدیر اولیه؛ بیرون Git و روی دیسک امن.                                                                              |
| `SEED_ADMIN_PASSWORD`   | فقط seed توسعه                     | تصادفی در نبود مقدار         | رمز مدیر dev فقط هنگام ساخت کاربر؛ هرگز برای production/seed استفاده نشود.                                                                 |
| `DEV_API_KEY`           | فقط `scripts/dev-snapshot.mjs`     | مقدار ثابت dev در اسکریپت    | کلید آزمایشی snapshot محلی؛ نه راز production و نه مسیری برای bootstrap production.                                                        |

## CI و تست‌های یکپارچه (نه تنظیمات production)

این نام‌ها برای اجرای خودکار/محلی CI مستند شده‌اند تا مرجع env کامل بماند. آن‌ها را در `.env` production لازم ندارید.

| متغیر                       | مصرف‌کننده                                                   | لازم؟ / پیش‌فرض               | کاربرد                                                                                          |
| --------------------------- | ------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `CI`                        | آستانهٔ تست performance در `packages/routing` و محیط Actions | GitHub آن را `true` می‌کند    | روی runner مشترک آستانهٔ نوسانی تست مسیر را شل‌تر می‌کند؛ رفتار اپ production را تغییر نمی‌دهد. |
| `INTEGRATION_DATABASE_URL`  | تست‌های integration control-api/worker                       | بدون آن بخش مربوط skip می‌شود | URL دیتابیس ایزولهٔ تست؛ هرگز دیتابیس production نباشد.                                         |
| `INTEGRATION_VALKEY_URL`    | تست‌های integration gateway/control-api/worker               | بدون آن بخش مربوط skip می‌شود | URL Valkey ایزولهٔ تست.                                                                         |
| `INTEGRATION_DATABASE_NAME` | `scripts/ci/services.integration.mjs` و runner integration   | `dirouter_ci`                 | نام DB تست داخل کانتینر، برای اجرای psql درست.                                                  |
| `POSTGRES_CONTAINER`        | smoke test زیرساخت CI                                        | الزامی برای آن اسکریپت        | شناسه/نام کانتینر PostgreSQL ایزوله؛ در workflow از service ID می‌آید.                          |
| `VALKEY_CONTAINER`          | smoke test زیرساخت CI                                        | الزامی برای آن اسکریپت        | شناسه/نام کانتینر Valkey ایزوله.                                                                |
| `GITHUB_EVENT_PATH`         | `scripts/ci/plan.mjs`                                        | GitHub Actions                | مسیر JSON رویداد برای یافتن base SHA.                                                           |
| `GITHUB_EVENT_NAME`         | `scripts/ci/plan.mjs`                                        | GitHub Actions                | نوع event؛ push/PR/manual برای انتخاب محدوده.                                                   |
| `GITHUB_REF`                | `scripts/ci/plan.mjs`                                        | GitHub Actions                | ref فعلی؛ اعتبارسنجی tag انتشار.                                                                |
| `GITHUB_SHA`                | `scripts/ci/plan.mjs`                                        | GitHub Actions                | head SHA برای diff و انتخاب package.                                                            |
| `GITHUB_OUTPUT`             | `scripts/ci/plan.mjs`                                        | GitHub Actions                | فایل خروجی step برای filter/matrix.                                                             |
| `GITHUB_STEP_SUMMARY`       | `scripts/ci/plan.mjs`                                        | GitHub Actions                | فایل خلاصهٔ اجرای CI.                                                                           |
| `TURBO_TELEMETRY_DISABLED`  | محیط CI/Turborepo                                            | workflow مقدار `1` می‌دهد     | خاموش‌کردن telemetry ابزار build؛ توسط کد اپ خوانده نمی‌شود.                                    |
| `HUSKY`                     | نصب CI                                                       | setup مقدار `0` می‌دهد        | غیرفعال‌کردن hook هنگام install روی runner؛ توسط کد اپ خوانده نمی‌شود.                          |
| `REPOSITORY`                | step نام‌گذاری image CI                                      | از context GitHub             | نام repository برای ساخت نام lowercase GHCR؛ متغیر محلی workflow.                               |
| `APP`                       | step نام‌گذاری image CI                                      | از matrix GitHub              | نام اپ برای image GHCR؛ متغیر محلی workflow، نه پیکربندی اجرای برنامه.                          |
| `TURBO_FILTER`              | step بررسی packageها                                         | خروجی job `plan`              | فیلتر Turbo برای انتخاب packageهای تغییرکرده و وابسته‌ها.                                       |
| `PLAN`                      | step نهایی `CI passed`                                       | نتیجهٔ job plan               | رشتهٔ وضعیت برای جلوگیری از success شدن تجمعی با job ناموفق.                                    |
| `CHECKS`                    | step نهایی `CI passed`                                       | نتیجهٔ job checks             | وضعیت lint/typecheck/test/build؛ باید `success` باشد.                                           |
| `INTEGRATION`               | step نهایی `CI passed`                                       | نتیجهٔ job integration        | وضعیت تست یکپارچه؛ بسته به انتخاب package باید success یا skipped باشد.                         |
| `IMAGES`                    | step نهایی `CI passed`                                       | نتیجهٔ job images             | وضعیت build/publish ایمیج‌ها؛ بسته به matrix باید success یا skipped باشد.                      |
| `HAS_PACKAGES`              | step نهایی `CI passed`                                       | خروجی plan                    | تعیین می‌کند integration الزامی است یا باید skip شده باشد.                                      |
| `HAS_IMAGES`                | step نهایی `CI passed`                                       | خروجی plan                    | تعیین می‌کند job image الزامی است یا باید skip شده باشد.                                        |

### آدرس‌های تست end-to-end

| متغیر             | مصرف‌کننده                 | پیش‌فرض                  | توضیح                                              |
| ----------------- | -------------------------- | ------------------------ | -------------------------------------------------- |
| `E2E_GATEWAY_URL` | `scripts/e2e/sprint-1.mjs` | `http://api.localhost`   | ورودی گیت‌وی پشت Traefik در محیط ایزولهٔ تست.      |
| `E2E_ADMIN_URL`   | `scripts/e2e/sprint-1.mjs` | `http://admin.localhost` | ورودی control-api برای ساخت fixture و بررسی وضعیت. |
| `E2E_MOCK_URL`    | `scripts/e2e/sprint-1.mjs` | `http://mock.localhost`  | ورودی mock provider برای تزریق خطا.                |

این suite عمداً سرویس‌ها را متوقف می‌کند؛ فقط روی محیط اختصاصی توسعه/تست اجرا شود، نه production.

## تفکیک امن و حداقل دسترسی

- `MASTER_KEY`، `KEY_PEPPER`، `JWT_SECRET`، `INTERNAL_TOKEN`، `POSTGRES_PASSWORD`، `DATABASE_URL` و `SMTP_URL` راز یا حاوی رازند.
- gateway فقط به `MASTER_KEY`، `KEY_PEPPER`، `INTERNAL_TOKEN`، `VALKEY_URL` و آدرس control-api نیاز دارد؛ **نه `DATABASE_URL`**.
- worker به Postgres و Valkey نیاز دارد و به رازهای JWT/master/internal نیاز ندارد.
- راز providerها در دیتابیس رمز شده‌اند و از داشبورد وارد می‌شوند؛ آن‌ها را در env نگذارید. راز DNS-01 (مثل `CF_DNS_API_TOKEN`) فقط در صورت فعال‌کردن challenge به Traefik داده می‌شود و بخشی از قرارداد اپ نیست.
