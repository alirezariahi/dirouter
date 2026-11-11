[English](#english) · [فارسی](#persian)

<a id="english"></a>

# CI Pipeline — Card 1.5

> All documentation in this repository is bilingual (English and Persian), and detailed guides live in code/docs/. See [CONTRIBUTING.md](../CONTRIBUTING.md).

Workflow file: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
The Git repository is in the `code/` folder; this document is inside the same repository so that it is versioned together with the pipeline.

## Run time and stages

The pipeline runs on every `pull_request`, on push to `main`, on push of a `v*` tag, and on manual runs (`workflow_dispatch`).
A new run for a PR cancels the previous run of the same PR; runs that publish from main and version tags are not cancelled.

| Job                               | Task                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan affected packages            | Selecting packages using the full Git history and building the image matrix                                                                  |
| Lint, types, unit tests and build | Root ESLint, formatting of the CI tooling, tests for package selection; then lint, typecheck, unit tests, and build of the selected packages |
| PostgreSQL and Valkey integration | Running a real test on an isolated PostgreSQL 17 and Valkey 8 with health checks                                                             |
| Image (app name)                  | Building the selected images with Buildx; publishing only for the push event and after the tests succeed                                     |
| CI passed                         | Checking the result of all required jobs; select this name as a required check in branch protection                                          |

Node.js is read from `.nvmrc`, and the pnpm version from `packageManager` in `package.json`.
Installation is always `pnpm install --frozen-lockfile`; a mismatch between the manifest and the lockfile causes a failure.
The pnpm store cache is keyed by the lockfile, the local Turborepo cache is keyed by OS/architecture/lockfile/commit, and the Docker layer caches are separate for each app.
Task outputs are reused based on Turborepo's own input hashes.
All external actions are pinned to a fixed commit SHA; the corresponding version is noted in a comment.

## Package and image selection

The script [`scripts/ci/plan.mjs`](../scripts/ci/plan.mjs) uses the base SHA and the GitHub test-merge commit for PRs.
For a push to main, the base is the `before` of that event; therefore a push containing several commits is checked completely as well.
The comparison base is the merge-base of two commits. The following filter selects the changed packages and their consumers:

```bash
pnpm exec turbo run lint typecheck test build --filter="...[$BASE...$HEAD]"
```

The build dependencies are built through `dependsOn: ["^build"]`; a change in `shared` also triggers the tests and builds of the dependent apps.
The Docker matrix is built from the packages selected by Turbo.

| Change                                                                                        | Result                                                                              |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| One app                                                                                       | That app and its consumers                                                          |
| One shared package                                                                            | The package and the dependent apps                                                  |
| Documentation only                                                                            | CI tooling and root checks; no package builds or Docker, and no integration service |
| `node.Dockerfile`                                                                             | The four Node images                                                                |
| `dashboard.Dockerfile` or the nginx configuration                                             | The dashboard image                                                                 |
| `.dockerignore`                                                                               | All images                                                                          |
| Root manifest/lockfile, Turbo/Node/ESLint/Prettier configuration, `.github/` or `scripts/ci/` | Full check and all images                                                           |
| First push, unavailable history, manual run, or a version tag                                 | Full check and all images                                                           |

Available images: `gateway`, `control-api`, `worker`, `mock-provider`, and `dashboard`.
The Dockerfiles in `deploy/docker/` are prerequisites for the image stage and must be available to the runner along with the repository.
In this card only `linux/amd64` is built; multi-architecture builds belong to card 2.1.

## Integration test and local reproduction

The test [`services.integration.mjs`](../scripts/ci/services.integration.mjs) uses clients inside the containers via `docker exec`; there is no need to install SQL/Valkey clients on the runner or to publish ports.
The PostgreSQL test creates a temporary table inside a transaction, round-trips a computed cost through the `money` module, a key hash, and an encrypted credential, and then rolls back.
The Valkey test checks the `SET NX PX` lock, the TTL, and the concurrent `INCR` counter, and deletes its own keys.
These tests measure the current infrastructure and the shared package; migrations and tests for future domains are added in their respective cards.

```bash
pnpm install --frozen-lockfile
pnpm exec eslint .
pnpm exec prettier --check .github scripts/ci CI.md
node --test scripts/ci/plan.test.mjs
pnpm exec turbo run lint typecheck test build

docker run -d --name dirouter-ci-postgres \
  -e POSTGRES_USER=dirouter -e POSTGRES_PASSWORD=ci-only-password \
  -e POSTGRES_DB=dirouter_ci \
  --health-cmd='pg_isready -U dirouter -d dirouter_ci' \
  --health-interval=5s --health-timeout=3s --health-retries=12 postgres:17-alpine
docker run -d --name dirouter-ci-valkey \
  --health-cmd='valkey-cli ping' \
  --health-interval=5s --health-timeout=3s --health-retries=12 valkey/valkey:8-alpine

# After both containers are healthy:
pnpm exec turbo run build --filter=@dirouter/shared
POSTGRES_CONTAINER=dirouter-ci-postgres VALKEY_CONTAINER=dirouter-ci-valkey \
  node --test scripts/ci/services.integration.mjs

docker rm -f dirouter-ci-postgres dirouter-ci-valkey
```

In CI the services are created and removed automatically. The password values in the example are only for the disposable test database.
Integration tests run outside the Turbo cache so that a stale result does not replace a real connection to the services.

## Registry, tags, and permissions

The registry is `ghcr.io`, and the name of each image is built from the repository path (in lowercase):

```text
ghcr.io/alirezariahi/dirouter/gateway:sha-<full-commit-sha>
ghcr.io/alirezariahi/dirouter/gateway:1.2.3
ghcr.io/alirezariahi/dirouter/gateway:1.3.0-rc.1
```

On main, only the changed images are published, with the SHA tag.
A valid SemVer tag such as `v1.2.3` publishes all images with the SHA tag and the version; the `latest` tag is not produced.
Invalid `v*` tags fail. The tagged commit must be in the history of `origin/main`; this check is performed before anything enters the registry.
PRs, including PRs from forks, only build the image and do not push it to the registry; manual runs do not publish either.
No automatic deployment is performed.

| Variable/permission                                                  | Provision and use                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                                                       | Automatic from GitHub; only the image job has `packages: write` permission |
| `contents: read`                                                     | Minimum default permission for checkout                                    |
| `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_SHA` | Automatic; input for package selection                                     |
| `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`                               | Automatic; matrix output and the package selection report                  |
| `POSTGRES_CONTAINER`, `VALKEY_CONTAINER`                             | Service IDs of the same job; configurable for local runs                   |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`                  | Fixed settings of the disposable CI database; no connection to production  |
| `HUSKY=0`                                                            | Only during CI installation; the development hook is not installed         |
| `TURBO_TELEMETRY_DISABLED=1`                                         | Disables the build tool's telemetry in CI                                  |

No custom secret, dtask token, provider key, or production variable is needed for this pipeline.
If the GHCR package already exists, enable Actions access for this repository in its settings.
To prevent merging without review, enable the required check named `CI passed` for main.

## Acceptance status

Local check on 2026-11-07: all 40 quality/build tasks succeeded; 62 existing unit tests, 9 package-selection tests (including real Git and Turbo), and 2 real service tests passed. ESLint for the CI tooling, Prettier, `actionlint`, and `git diff --check` also passed.
Five images were built on an ARM64 host, and the health of the control-api image was healthy. The Docker command for control-api did not terminate after the build/export stages finished and was stopped; therefore this run does not confirm complete success of the Docker command. The Linux AMD64 runner and GHCR publishing have not been verified yet.

The local check does not replace the GitHub run. The criterion "the pipeline on the main branch is green" is confirmed after the commit/push and after observing a successful run on main.
The half-finished Dockerfiles of card 2.1 must also be in the repository checkout; their presence on the local disk alone is not enough for the runner.
Code review sign-off is a separate step; running the tools does not tick it off in its place.

## References

- [CI execution and Git filter in Turborepo](https://turborepo.dev/docs/crafting-your-repository/constructing-ci)
- [PostgreSQL service in GitHub Actions](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
- [Publishing Docker images with GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [SHA and SemVer tags in docker/metadata-action](https://github.com/docker/metadata-action)

---

<a id="persian"></a>

# پایپلاین CI — کارت ۱.۵

> تمام مستندات این مخزن دوزبانه (انگلیسی و فارسی) است و راهنماهای تفصیلی در code/docs/ نگهداری می‌شوند. برای مشارکت به [CONTRIBUTING.md](../CONTRIBUTING.md) مراجعه کنید.

فایل اجرایی: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
مخزن Git در پوشهٔ `code/` قرار دارد؛ این سند داخل همان مخزن است تا همراه پایپلاین نسخه‌بندی شود.

## زمان اجرا و مراحل

پایپلاین روی هر `pull_request`، push به `main`، push تگ `v*` و اجرای دستی (`workflow_dispatch`) اجرا می‌شود.
اجرای جدید یک PR، اجرای قبلی همان PR را لغو می‌کند؛ انتشارهای main و نسخه‌ها لغو نمی‌شوند.

| job                               | کار                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Plan affected packages            | انتخاب بسته‌ها با تاریخچهٔ کامل Git و ساخت ماتریس ایمیج‌ها                                                     |
| Lint, types, unit tests and build | ESLint ریشه، قالب‌بندی ابزار CI، تست انتخاب بسته‌ها؛ سپس lint، typecheck، تست واحد و build بسته‌های انتخاب‌شده |
| PostgreSQL and Valkey integration | اجرای تست واقعی روی PostgreSQL 17 و Valkey 8 ایزوله با healthcheck                                             |
| Image (نام اپ)                    | build ایمیج‌های انتخاب‌شده با Buildx؛ انتشار فقط برای رویداد push و پس از موفقیت تست‌ها                        |
| CI passed                         | بررسی نتیجهٔ همهٔ jobهای لازم؛ این نام را در branch protection به‌عنوان required check انتخاب کنید             |

Node.js از `.nvmrc` و نسخهٔ pnpm از `packageManager` در `package.json` خوانده می‌شوند.
نصب همیشه با `pnpm install --frozen-lockfile` است؛ اختلاف manifest و lockfile باعث شکست می‌شود.
کش store پنپم بر اساس lockfile، کش محلی Turborepo بر اساس سیستم‌عامل/معماری/lockfile/commit و کش لایه‌های Docker برای هر اپ جداست.
خروجی taskها بر اساس هش ورودی‌های خود Turborepo بازاستفاده می‌شود.
همهٔ actionهای خارجی به commit SHA ثابت متصل‌اند؛ نسخهٔ متناظر در کامنت آمده است.

## انتخاب بسته‌ها و ایمیج‌ها

اسکریپت [`scripts/ci/plan.mjs`](../scripts/ci/plan.mjs) برای PR از base SHA و commit ادغام آزمایشی GitHub استفاده می‌کند.
برای push به main، مبنا `before` همان رویداد است؛ بنابراین push شامل چند کامیت هم کامل بررسی می‌شود.
مبنای مقایسه merge-base دو commit است. فیلتر زیر بسته‌های تغییرکرده و مصرف‌کنندگان آن‌ها را انتخاب می‌کند:

```bash
pnpm exec turbo run lint typecheck test build --filter="...[$BASE...$HEAD]"
```

وابستگی‌های موردنیاز build از طریق `dependsOn: ["^build"]` ساخته می‌شوند؛ تغییر `shared` تست و build اپ‌های وابسته را هم فعال می‌کند.
ماتریس Docker از بسته‌های انتخاب‌شده توسط Turbo ساخته می‌شود.

| تغییر                                                                                 | نتیجه                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| یک اپ                                                                                 | همان اپ و مصرف‌کنندگانش                                                  |
| یک پکیج مشترک                                                                         | پکیج و اپ‌های وابسته                                                     |
| فقط مستندات                                                                           | بررسی ابزار CI و ریشه؛ بدون build بسته‌ها یا Docker و بدون سرویس یکپارچه |
| `node.Dockerfile`                                                                     | چهار ایمیج Node                                                          |
| `dashboard.Dockerfile` یا تنظیم nginx                                                 | ایمیج dashboard                                                          |
| `.dockerignore`                                                                       | همهٔ ایمیج‌ها                                                            |
| manifest/lockfile ریشه، تنظیم Turbo/Node/ESLint/Prettier، `.github/` یا `scripts/ci/` | بررسی کامل و همهٔ ایمیج‌ها                                               |
| اولین push، تاریخچهٔ غیرقابل‌دسترسی، اجرای دستی یا تگ نسخه                            | بررسی کامل و همهٔ ایمیج‌ها                                               |

ایمیج‌های موجود: `gateway`، `control-api`، `worker`، `mock-provider` و `dashboard`.
Dockerfileهای موجود در `deploy/docker/` پیش‌نیاز اجرای مرحلهٔ ایمیج هستند و باید همراه مخزن در دسترس runner باشند.
در این کارت فقط `linux/amd64` ساخته می‌شود؛ ساخت چندمعماری مربوط به کارت ۲.۱ است.

## تست یکپارچه و بازتولید محلی

تست [`services.integration.mjs`](../scripts/ci/services.integration.mjs) از کلاینت‌های داخل کانتینر با `docker exec` استفاده می‌کند؛ نصب کلاینت SQL/Valkey روی runner و انتشار پورت‌ها لازم نیست.
تست PostgreSQL یک جدول موقت در تراکنش می‌سازد، هزینهٔ محاسبه‌شده با ماژول `money`، هش کلید و credential رمز‌شده را رفت‌وبرگشت می‌دهد و rollback می‌کند.
تست Valkey، قفل `SET NX PX`، TTL و شمارندهٔ هم‌زمان `INCR` را بررسی و کلیدهای خود را پاک می‌کند.
این تست‌ها زیرساخت و پکیج shared فعلی را می‌سنجند؛ migration و تست دامنه‌های آینده در کارت‌های مربوط اضافه می‌شوند.

```bash
pnpm install --frozen-lockfile
pnpm exec eslint .
pnpm exec prettier --check .github scripts/ci CI.md
node --test scripts/ci/plan.test.mjs
pnpm exec turbo run lint typecheck test build

docker run -d --name dirouter-ci-postgres \
  -e POSTGRES_USER=dirouter -e POSTGRES_PASSWORD=ci-only-password \
  -e POSTGRES_DB=dirouter_ci \
  --health-cmd='pg_isready -U dirouter -d dirouter_ci' \
  --health-interval=5s --health-timeout=3s --health-retries=12 postgres:17-alpine
docker run -d --name dirouter-ci-valkey \
  --health-cmd='valkey-cli ping' \
  --health-interval=5s --health-timeout=3s --health-retries=12 valkey/valkey:8-alpine

# پس از healthy شدن هر دو کانتینر:
pnpm exec turbo run build --filter=@dirouter/shared
POSTGRES_CONTAINER=dirouter-ci-postgres VALKEY_CONTAINER=dirouter-ci-valkey \
  node --test scripts/ci/services.integration.mjs

docker rm -f dirouter-ci-postgres dirouter-ci-valkey
```

در CI سرویس‌ها خودکار ساخته و حذف می‌شوند. مقادیر رمز در مثال فقط برای دیتابیس دورریختنی تست هستند.
تست‌های یکپارچه خارج از کش Turbo اجرا می‌شوند تا نتیجهٔ قدیمی جای اتصال واقعی سرویس‌ها را نگیرد.

## رجیستری، تگ‌ها و مجوزها

رجیستری `ghcr.io` است و نام هر ایمیج از مسیر مخزن (با حروف کوچک) ساخته می‌شود:

```text
ghcr.io/alirezariahi/dirouter/gateway:sha-<full-commit-sha>
ghcr.io/alirezariahi/dirouter/gateway:1.2.3
ghcr.io/alirezariahi/dirouter/gateway:1.3.0-rc.1
```

روی main فقط ایمیج‌های تغییرکرده با تگ SHA منتشر می‌شوند.
تگ معتبر SemVer مانند `v1.2.3` همهٔ ایمیج‌ها را با تگ SHA و نسخه منتشر می‌کند؛ تگ `latest` تولید نمی‌شود.
تگ‌های نامعتبر `v*` شکست می‌خورند. commit تگ باید در تاریخچهٔ `origin/main` باشد؛ این بررسی پیش از ورود به رجیستری انجام می‌شود.
PRها، از جمله PR از fork، ایمیج را فقط build می‌کنند و به رجیستری وارد نمی‌شوند؛ اجرای دستی هم انتشار ندارد.
هیچ استقرار خودکاری انجام نمی‌شود.

| متغیر/مجوز                                                           | تأمین و کاربرد                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GITHUB_TOKEN`                                                       | خودکار از GitHub؛ فقط job ایمیج مجوز `packages: write` دارد    |
| `contents: read`                                                     | حداقل مجوز پیش‌فرض برای checkout                               |
| `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_SHA` | خودکار؛ ورودی انتخاب بسته‌ها                                   |
| `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`                               | خودکار؛ خروجی ماتریس و گزارش انتخاب بسته‌ها                    |
| `POSTGRES_CONTAINER`, `VALKEY_CONTAINER`                             | شناسهٔ سرویس‌های همان job؛ برای اجرای محلی قابل تنظیم          |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`                  | تنظیم ثابت دیتابیس دورریختنی CI؛ هیچ اتصال به production ندارد |
| `HUSKY=0`                                                            | فقط هنگام نصب CI؛ hook توسعه نصب نمی‌شود                       |
| `TURBO_TELEMETRY_DISABLED=1`                                         | غیرفعال‌کردن telemetry ابزار build در CI                       |

Secret سفارشی، توکن دی‌تسک، کلید provider یا متغیر production برای این پایپلاین لازم نیست.
اگر بستهٔ GHCR از قبل وجود دارد، در تنظیمات آن دسترسی Actions همین مخزن را فعال کنید.
برای جلوگیری از ادغام بدون بررسی، required check به نام `CI passed` را برای main فعال کنید.

## وضعیت پذیرش

بررسی محلی در ۲۰۲۶-۱۱-۰۷: هر ۴۰ task کیفیت/build موفق بود؛ ۶۲ تست واحد موجود، ۹ تست انتخاب بسته‌ها (شامل Git و Turbo واقعی) و ۲ تست سرویس واقعی سبز شدند. ESLint ابزار CI، Prettier، `actionlint` و `git diff --check` هم موفق بودند.
پنج ایمیج روی میزبان ARM64 ساخته شدند و health ایمیج control-api سالم بود. فرمان Docker برای control-api پس از پایان مراحل build/export خاتمه نیافت و متوقف شد؛ بنابراین این اجرا تأیید موفقیت کامل فرمان Docker محسوب نمی‌شود. اجرای runner لینوکسی AMD64 و انتشار GHCR هنوز بررسی نشده‌اند.

بررسی محلی جای اجرای GitHub را نمی‌گیرد. معیار «پایپلاین روی شاخهٔ اصلی سبز است» پس از commit/push و مشاهدهٔ اجرای موفق روی main تأیید می‌شود.
Dockerfileهای نیمه‌کارهٔ کارت ۲.۱ هم باید در checkout مخزن باشند؛ صرف وجود آن‌ها روی دیسک محلی برای runner کافی نیست.
تأیید بازبینی کد یک مرحلهٔ مستقل است و اجرای ابزارها به‌جای آن علامت نمی‌خورد.

## منابع

- [اجرای CI و فیلتر Git در Turborepo](https://turborepo.dev/docs/crafting-your-repository/constructing-ci)
- [سرویس PostgreSQL در GitHub Actions](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
- [انتشار Docker image با GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [تگ‌های SHA و SemVer در docker/metadata-action](https://github.com/docker/metadata-action)
