[English](#english) · [فارسی](#persian)

<a id="english"></a>

# CI pipeline

Prepared workflow path: `.github/workflows/ci.yml`.
The Git repository is rooted at `code/` in the local project layout. This guide describes the prepared CI implementation; the workflow, scripts, and Dockerfiles must be published before GitHub can run it.

## Triggers and stages

The workflow runs on every `pull_request`, pushes to `main`, `v*` tag pushes, and manual dispatch (`workflow_dispatch`). A new run cancels an earlier run for the same PR. Main and release runs are not cancelled automatically.

| Job                               | Purpose                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan affected packages            | Use full Git history to select packages and construct the image matrix                                                                                                    |
| Lint, types, unit tests and build | Lint root configuration, check CI-tooling formatting, test package selection and environment-reference coverage, then lint, type-check, test, and build selected packages |
| PostgreSQL and Valkey integration | Run real integration tests against disposable, health-checked PostgreSQL 17 and Valkey 8 Testcontainers; apply all migrations                                             |
| Image (application name)          | Build selected images with Buildx; publish only on push events after successful checks                                                                                    |
| CI passed                         | Require all applicable jobs to succeed; select this name as a required check in branch protection                                                                         |

Node.js is read from `.nvmrc`; pnpm is pinned by `packageManager` in `package.json`. Installation always uses `pnpm install --frozen-lockfile`, so a manifest/lockfile mismatch fails the job.

The pnpm store is cached by lockfile. The local Turborepo cache is keyed by operating system, architecture, lockfile, and commit, with prefix restoration. Docker layer caches are scoped by application. Turborepo validates reusable task outputs against its own input hashes. External actions are pinned to commit SHAs, with corresponding versions in comments.

## Package and image selection

`scripts/ci/plan.mjs` compares the PR base SHA to GitHub's checked-out test merge commit. For main pushes, it uses the event's `before` commit so multi-commit pushes are covered. The comparison starts at the merge base of the two commits.

The following filter selects changed packages and their dependents:

```bash
pnpm exec turbo run lint typecheck test build --filter="...[$BASE...$HEAD]"
```

Required build dependencies are included through `dependsOn: ["^build"]`. A change to `shared` therefore also tests and builds dependent applications. The Docker matrix is derived from the packages selected by Turbo.

| Change                                                                                         | Result                                                                      |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| One application                                                                                | That application and its dependents                                         |
| A shared package                                                                               | That package and dependent applications                                     |
| Documentation only                                                                             | Root and CI-tooling checks; no package/image builds or integration services |
| `node.Dockerfile`                                                                              | All four Node images                                                        |
| `dashboard.Dockerfile` or nginx configuration                                                  | Dashboard image                                                             |
| `.dockerignore`                                                                                | All images                                                                  |
| Root manifest/lockfile, Turbo/Node/ESLint/Prettier configuration, `.github/`, or `scripts/ci/` | Full checks and all images                                                  |
| Initial push, unavailable history, manual dispatch, or a release tag                           | Full checks and all images                                                  |

Images: `gateway`, `control-api`, `worker`, `mock-provider`, `dashboard`, and `migrate`. Changes to `@dirouter/db` or `migrate.Dockerfile` select the migration image even though it has no separate workspace package.

The existing Dockerfiles under `deploy/docker/` are prerequisites for the image stage and must be present in the runner's checkout. The prepared image stage builds `linux/amd64` only; multi-architecture support is separate work.

The environment check scans literal Node/Vite reads, Zod application schemas, Compose interpolation, the dashboard nginx template, and GitHub Actions `env` blocks. It fails for missing or stale structured entries in `docs/env-reference.md`. Development, test, and CI-only variables belong in separate sections of that reference, not automatically in the production `.env`.

## Test coverage and Testcontainers

`pnpm test` runs Vitest with V8 coverage for every package test task. `vitest.shared.ts` supplies HTML, LCOV, JSON-summary and terminal reports under each package's `coverage/` directory. The shared default threshold is 70% for statements, branches, functions and lines. `packages/translator` requires 90% globally; `packages/routing` and `apps/gateway` require 90% for `router.ts` and `rate-limiter.ts` respectively. Entrypoints, generated clients and pure re-export modules are excluded from coverage. `pnpm test:unit` runs the same suites without collecting coverage. `node scripts/ci/coverage-summary.mjs` prints a package table for the GitHub step summary. Unit and integration coverage are uploaded as separate 14-day artifacts.

The integration runner starts disposable `postgres:17-alpine` and `valkey/valkey:8-alpine` containers on ephemeral host ports, waits for their health checks, applies all Prisma migrations, and runs the infrastructure, worker, control-api and gateway suites. It stops both containers on success or failure. Integration jobs are not cached by Turbo, so a previous successful run cannot replace a live service connection.

```bash
pnpm install --frozen-lockfile
npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/integration
pnpm test:integration
```

The isolated npm lockfile under `scripts/integration/` pins the Testcontainers runtime without changing the application's pnpm dependency graph. Docker must be running. Individual integration suites still accept `INTEGRATION_DATABASE_URL` and `INTEGRATION_VALKEY_URL` for debugging against an existing disposable environment, but no pre-running local services are needed for the standard command above.

`pnpm exec turbo run lint typecheck test build --filter="$TURBO_FILTER"` enforces coverage in affected package jobs. Application suites that rely on real services collect reports in both unit and integration stages; their enforced 70% gate is evaluated in the integration stage rather than against skipped tests. New feature pages and modules must retain the package-level threshold.

## Integration tests and local reproduction

`scripts/ci/services.integration.mjs` uses clients inside the containers through `docker exec`; no SQL/Valkey clients or published service ports are needed on the runner.

The PostgreSQL test creates a temporary table inside a transaction, round-trips a cost calculated by the `money` module, a key hash, and an encrypted credential, then rolls back. The Valkey test checks `SET NX PX` locks, TTLs, and concurrent atomic `INCR` counters, then removes its keys.

These infrastructure tests check the shared package, real locks and counters, and transaction semantics. Domain integration suites then exercise migrations, the usage pipeline, dashboard APIs and distributed gateway behavior.

```bash
pnpm install --frozen-lockfile
pnpm exec eslint .
pnpm exec prettier --check .github scripts/ci CI.md
node --test scripts/ci/plan.test.mjs
node --test scripts/ci/env-docs.test.mjs
node scripts/ci/check-env-docs.mjs
pnpm exec turbo run lint typecheck test build

docker run -d --name dirouter-ci-postgres \
  -e POSTGRES_USER=dirouter -e POSTGRES_PASSWORD=ci-only-password \
  -e POSTGRES_DB=dirouter_ci \
  --health-cmd='pg_isready -U dirouter -d dirouter_ci' \
  --health-interval=5s --health-timeout=3s --health-retries=12 postgres:17-alpine
docker run -d --name dirouter-ci-valkey \
  --health-cmd='valkey-cli ping' \
  --health-interval=5s --health-timeout=3s --health-retries=12 valkey/valkey:8-alpine

# Once both containers are healthy:
pnpm exec turbo run build --filter=@dirouter/shared
POSTGRES_CONTAINER=dirouter-ci-postgres VALKEY_CONTAINER=dirouter-ci-valkey \
  node --test scripts/ci/services.integration.mjs

docker rm -f dirouter-ci-postgres dirouter-ci-valkey
```

CI creates and removes the Testcontainers automatically. The example password is for a disposable test database only. Integration tests run outside the Turbo cache so a cached result cannot replace a real service connection.

## Registry, tags, and permissions

Images are published to `ghcr.io`, using the lowercase repository path:

```text
ghcr.io/alirezariahi/dirouter/gateway:sha-<full-commit-sha>
ghcr.io/alirezariahi/dirouter/gateway:1.2.3
ghcr.io/alirezariahi/dirouter/gateway:1.3.0-rc.1
```

Main pushes publish only affected images with SHA tags. A valid SemVer tag such as `v1.2.3` publishes every image with both SHA and version tags. No `latest` tag is generated.

Invalid `v*` tags fail. A release tag's commit must be in the history of `origin/main`; this is checked before registry login. PRs, including fork PRs, build without logging into the registry or publishing. Manual dispatch also does not publish. The workflow does not deploy the application.

| Variable or permission                                               | Source and purpose                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GITHUB_TOKEN`                                                       | Provided by GitHub; only the image job requests `packages: write`   |
| `contents: read`                                                     | Default minimum permission for checkout                             |
| `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_SHA` | GitHub-provided inputs for package selection                        |
| `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`                               | GitHub-provided paths for matrix outputs and selection summaries    |
| `POSTGRES_CONTAINER`, `VALKEY_CONTAINER`                             | Container IDs from the current job; configurable locally            |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`                  | Disposable CI database configuration; never a production connection |
| `HUSKY=0`                                                            | Set during CI installation to disable development hooks             |
| `TURBO_TELEMETRY_DISABLED=1`                                         | Disable build-tool telemetry in CI                                  |

No custom secret, DiTask token, provider key, or production configuration is required. If the GHCR package already exists, grant this repository's Actions access in its package settings. To prevent unchecked merges, require the `CI passed` check on main.

## References

- [CI construction and Git filtering in Turborepo](https://turborepo.dev/docs/crafting-your-repository/constructing-ci)
- [PostgreSQL services in GitHub Actions](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
- [Publishing Docker images with GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [SHA and SemVer tags in docker/metadata-action](https://github.com/docker/metadata-action)

---

<a id="persian"></a>

# خط لوله CI

مسیر workflow آماده‌شده: `.github/workflows/ci.yml`.
مخزن Git در چیدمان محلی پروژه از پوشه `code/` شروع می‌شود. این راهنما پیاده‌سازی آماده‌شدهٔ CI را توصیف می‌کند؛ workflow، اسکریپت‌ها و Dockerfileها باید منتشر شوند تا GitHub بتواند آن را اجرا کند.

## محرک‌ها و مراحل

workflow روی هر `pull_request`، push به `main`، push تگ‌های `v*` و اجرای دستی (`workflow_dispatch`) اجرا می‌شود. اجرای جدید برای یک PR، اجرای قبلی همان PR را لغو می‌کند. اجراهای main و release به‌طور خودکار لغو نمی‌شوند.

| Job                               | هدف                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan affected packages            | استفاده از کل تاریخچه Git برای انتخاب پکیج‌ها و ساخت ماتریس image                                                                                     |
| Lint, types, unit tests and build | lint پیکربندی ریشه، بررسی قالب‌بندی ابزارهای CI، تست انتخاب پکیج‌ها و پوشش مراجع متغیرهای محیطی؛ سپس lint، بررسی نوع، تست و build پکیج‌های انتخاب‌شده |
| PostgreSQL and Valkey integration | اجرای تست‌های یکپارچه‌سازی واقعی روی Testcontainerهای یک‌بارمصرف و دارای health check از PostgreSQL 17 و Valkey 8؛ اعمال همه migrationها              |
| Image (application name)          | ساخت imageهای انتخاب‌شده با Buildx؛ انتشار فقط در رویدادهای push و پس از موفقیت بررسی‌ها                                                              |
| CI passed                         | الزام موفقیت همه jobهای مرتبط؛ این نام را به‌عنوان check الزامی در branch protection انتخاب کنید                                                      |

Node.js از `.nvmrc` خوانده می‌شود؛ pnpm با فیلد `packageManager` در `package.json` ثابت شده است. نصب همیشه با `pnpm install --frozen-lockfile` انجام می‌شود، بنابراین ناسازگاری بین manifest و lockfile باعث شکست job می‌شود.

store مربوط به pnpm بر اساس lockfile کش می‌شود. کش محلی Turborepo بر اساس سیستم‌عامل، معماری، lockfile و commit کلیددار است و با بازیابی prefix کار می‌کند. کش لایه‌های Docker به هر برنامه جدا محدود است. Turborepo خروجی‌های قابل‌استفاده مجدد را با hashهای ورودی خودش اعتبارسنجی می‌کند. actionهای خارجی به SHA کامیت‌ها پین شده‌اند و نسخه‌های متناظر در کامنت‌ها آمده‌اند.

## انتخاب پکیج و image

`scripts/ci/plan.mjs` کامیت پایه PR را با commit ادغام آزمایشی که GitHub checkout کرده مقایسه می‌کند. برای pushهای main از فیلد `before` رویداد استفاده می‌شود تا pushهای چندکامیتی پوشش داده شوند. مقایسه از merge base دو کامیت شروع می‌شود.

فیلتر زیر پکیج‌های تغییرکرده و وابسته‌های آن‌ها را انتخاب می‌کند:

```bash
pnpm exec turbo run lint typecheck test build --filter="...[$BASE...$HEAD]"
```

وابستگی‌های لازم build از طریق `dependsOn: ["^build"]` افزوده می‌شوند. بنابراین تغییر در `shared` تست و build برنامه‌های وابسته را هم شامل می‌شود. ماتریس Docker از پکیج‌هایی ساخته می‌شود که Turbo انتخاب کرده است.

| تغییر                                                                                    | نتیجه                                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| یک برنامه                                                                                | آن برنامه و وابسته‌های آن                                                         |
| یک پکیج مشترک                                                                            | آن پکیج و برنامه‌های وابسته                                                       |
| فقط مستندات                                                                              | بررسی‌های ریشه و ابزارهای CI؛ بدون build پکیج/image و بدون سرویس‌های یکپارچه‌سازی |
| `node.Dockerfile`                                                                        | هر چهار image Node                                                                |
| `dashboard.Dockerfile` یا پیکربندی nginx                                                 | image داشبورد                                                                     |
| `.dockerignore`                                                                          | همه imageها                                                                       |
| manifest/lockfile ریشه، پیکربندی Turbo/Node/ESLint/Prettier، `.github/` یا `scripts/ci/` | بررسی‌های کامل و همه imageها                                                      |
| push اولیه، تاریخچه در دسترس نباشد، اجرای دستی یا تگ release                             | بررسی‌های کامل و همه imageها                                                      |

imageها: `gateway`، `control-api`، `worker`، `mock-provider`، `dashboard` و `migrate`. تغییر در `@dirouter/db` یا `migrate.Dockerfile` image مربوط به migration را انتخاب می‌کند، با اینکه این image پکیج جدا در workspace ندارد.

Dockerfileهای موجود در `deploy/docker/` پیش‌نیاز مرحله image هستند و باید در checkout روی runner وجود داشته باشند. مرحله image آماده‌شده فقط `linux/amd64` می‌سازد؛ پشتیبانی چندمعماری کار جداگانه‌ای است.

بررسی محیط، کدهای literal خواندن Node/Vite، schemaهای Zod برنامه‌ها، interpolation در Compose، قالب nginx داشبورد و بلوک‌های `env` در GitHub Actions را اسکن می‌کند. اگر ورودی ساختاریافته در `docs/env-reference.md` نباشد یا قدیمی باشد، بررسی شکست می‌خورد. متغیرهای توسعه، تست و فقط‌CI باید در بخش‌های جدا همان مرجع قرار گیرند و به‌صورت خودکار در `.env` تولید نیفتند.

## پوشش تست و Testcontainers

`pnpm test` برای هر job تست پکیج، Vitest را با پوشش V8 اجرا می‌کند. `vitest.shared.ts` گزارش‌های HTML، LCOV، JSON-summary و ترمینال را زیر پوشهٔ `coverage/` هر پکیج تولید می‌کند. آستانه پیش‌فرض مشترک ۷۰٪ برای statements، branches، functions و lines است. `packages/translator` پوشش کلی ۹۰٪ لازم دارد؛ `packages/routing` برای `router.ts` و `apps/gateway` برای `rate-limiter.ts` هر کدام ۹۰٪ لازم دارند. نقاط ورود، clientهای تولیدشده و ماژول‌های صرفاً re-export از پوشش حذف می‌شوند. `pnpm test:unit` همان مجموعه‌ها را بدون جمع‌آوری پوشش اجرا می‌کند. `node scripts/ci/coverage-summary.mjs` جدول پکیج‌ها را برای خلاصه مرحلهٔ GitHub چاپ می‌کند. گزارش‌های پوشش unit و integration به‌صورت دو artifact جدا با مدت نگه‌داری ۱۴ روز بارگذاری می‌شوند.

runner یکپارچه‌سازی کانتینرهای یک‌بارمصرف `postgres:17-alpine` و `valkey/valkey:8-alpine` را روی پورت‌های موقت میزبان راه می‌اندازد، منتظر health checkها می‌ماند، همه migrationهای Prisma را اعمال می‌کند و مجموعه‌های زیرساخت، worker، control-api و gateway را اجرا می‌کند. هر دو کانتینر چه موفقیت و چه شکست، متوقف می‌شوند. نتایج integration در Turbo کش نمی‌شوند تا یک اجرای موفق قبلی جای اتصال واقعی به سرویس را نگیرد.

```bash
pnpm install --frozen-lockfile
npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/integration
pnpm test:integration
```

lockfile مجزای npm در `scripts/integration/` runtime مربوط به Testcontainers را ثابت می‌کند، بدون اینکه گراف وابستگی pnpm برنامه تغییر کند. Docker باید در حال اجرا باشد. مجموعه‌های integration هنوز `INTEGRATION_DATABASE_URL` و `INTEGRATION_VALKEY_URL` را برای اشکال‌زدایی روی یک محیط یک‌بارمصرف موجود می‌پذیرند، اما برای دستور استاندارد بالا نیازی به سرویس محلی از پیش‌اجراشده نیست.

`pnpm exec turbo run lint typecheck test build --filter="$TURBO_FILTER"` پوشش را در jobهای پکیج تغییرکرده اجباری می‌کند. مجموعه‌های برنامه که به سرویس‌های واقعی وابسته‌اند، گزارش‌های خود را در مراحل unit و integration جمع می‌کنند؛ دروازه ۷۰٪ آن‌ها در مرحله integration ارزیابی می‌شود، نه روی تست‌های skip‌شده. صفحه‌ها و ماژول‌های جدید ویژگی باید آستانه سطح پکیج را حفظ کنند.

## تست‌های یکپارچه‌سازی و بازتولید محلی

`scripts/ci/services.integration.mjs` از کلاینت‌های داخل کانتینرها از طریق `docker exec` استفاده می‌کند؛ روی runner به کلاینت SQL/Valkey یا پورت‌های منتشرشدهٔ سرویس نیازی نیست.

تست PostgreSQL یک جدول موقت داخل یک تراکنش می‌سازد، هزینه محاسبه‌شده با ماژول `money`، هش یک کلید و یک اعتبارنامه رمزنگاری‌شده را رفت‌وبرگشت می‌دهد و سپس rollback می‌کند. تست Valkey قفل‌های `SET NX PX`، TTLها و شمارنده‌های همزمان و اتمی `INCR` را بررسی می‌کند و سپس کلیدهایش را حذف می‌کند.

این تست‌های زیرساخت، پکیج مشترک، قفل‌ها و شمارنده‌های واقعی و معناشناسی تراکنش‌ها را بررسی می‌کنند. مجموعه‌های integration دامنه‌ای، migrationها، pipeline مصرف، APIهای داشبورد و رفتار توزیع‌شدهٔ gateway را تمرین می‌دهند.

```bash
pnpm install --frozen-lockfile
pnpm exec eslint .
pnpm exec prettier --check .github scripts/ci CI.md
node --test scripts/ci/plan.test.mjs
node --test scripts/ci/env-docs.test.mjs
node scripts/ci/check-env-docs.mjs
pnpm exec turbo run lint typecheck test build

docker run -d --name dirouter-ci-postgres \
  -e POSTGRES_USER=dirouter -e POSTGRES_PASSWORD=ci-only-password \
  -e POSTGRES_DB=dirouter_ci \
  --health-cmd='pg_isready -U dirouter -d dirouter_ci' \
  --health-interval=5s --health-timeout=3s --health-retries=12 postgres:17-alpine
docker run -d --name dirouter-ci-valkey \
  --health-cmd='valkey-cli ping' \
  --health-interval=5s --health-timeout=3s --health-retries=12 valkey/valkey:8-alpine

# Once both containers are healthy:
pnpm exec turbo run build --filter=@dirouter/shared
POSTGRES_CONTAINER=dirouter-ci-postgres VALKEY_CONTAINER=dirouter-ci-valkey \
  node --test scripts/ci/services.integration.mjs

docker rm -f dirouter-ci-postgres dirouter-ci-valkey
```

CI کانتینرهای Testcontainers را خودکار ایجاد و حذف می‌کند. رمز نمونه فقط برای یک پایگاه داده تست یک‌بارمصرف است. تست‌های یکپارچه‌سازی خارج از کش Turbo اجرا می‌شوند تا نتیجه کش‌شده جای یک اتصال واقعی به سرویس را نگیرد.

## رجیستری، تگ‌ها و دسترسی‌ها

imageها در `ghcr.io` و با مسیر مخزن با حروف کوچک منتشر می‌شوند:

```text
ghcr.io/alirezariahi/dirouter/gateway:sha-<full-commit-sha>
ghcr.io/alirezariahi/dirouter/gateway:1.2.3
ghcr.io/alirezariahi/dirouter/gateway:1.3.0-rc.1
```

pushهای main فقط imageهای تغییرکرده را با تگ SHA منتشر می‌کنند. یک تگ SemVer معتبر مانند `v1.2.3` همه imageها را با هر دو تگ SHA و نسخه منتشر می‌کند. تگ `latest` تولید نمی‌شود.

تگ‌های نامعتبر `v*` شکست می‌خورند. کامیت یک تگ release باید در تاریخچه `origin/main` باشد؛ این بررسی قبل از ورود به registry انجام می‌شود. PRها، از جمله PRهای fork، بدون ورود به registry یا انتشار build می‌شوند. اجرای دستی هم منتشر نمی‌کند. workflow برنامه را مستقر (deploy) نمی‌کند.

| متغیر یا دسترسی                                                      | منبع و هدف                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN`                                                       | از سوی GitHub فراهم می‌شود؛ فقط job مربوط به image، `packages: write` درخواست می‌کند |
| `contents: read`                                                     | حداقل دسترسی پیش‌فرض برای checkout                                                   |
| `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_SHA` | ورودی‌های ارائه‌شده توسط GitHub برای انتخاب پکیج‌ها                                  |
| `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`                               | مسیرهای ارائه‌شده توسط GitHub برای خروجی ماتریس و خلاصه انتخاب‌ها                    |
| `POSTGRES_CONTAINER`, `VALKEY_CONTAINER`                             | شناسه کانتینرهای همین job؛ به‌صورت محلی قابل تنظیم است                               |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`                  | پیکربندی پایگاه داده یک‌بارمصرف CI؛ هرگز اتصال تولید نیست                            |
| `HUSKY=0`                                                            | در نصب CI تنظیم می‌شود تا hookهای توسعه غیرفعال شوند                                 |
| `TURBO_TELEMETRY_DISABLED=1`                                         | غیرفعال‌کردن telemetry ابزار build در CI                                             |

هیچ secret سفارشی، توکن DiTask، کلید provider یا پیکربندی تولید لازم نیست. اگر پکیج GHCR از قبل وجود دارد، در تنظیمات پکیج، دسترسی Actions این مخزن را اعطا کنید. برای جلوگیری از merge بدون بررسی، check با نام `CI passed` را روی main الزامی کنید.

## منابع

- [ساخت CI و فیلتر Git در Turborepo](https://turborepo.dev/docs/crafting-your-repository/constructing-ci)
- [سرویس‌های PostgreSQL در GitHub Actions](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
- [انتشار image داکر با GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [تگ‌های SHA و SemVer در docker/metadata-action](https://github.com/docker/metadata-action)
