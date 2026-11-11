[English](ci.fa.md) · [فارسی](ci.fa.md)

<div dir="rtl">

# پایپلاین CI — کارت ۱.۵

> هر سند دوزبانه است: یک فایل انگلیسی با پسوند `.md` و یک فایل فارسی با پسوند `.fa.md` کنار هم قرار دارند و راهنماهای تفصیلی در `code/docs/` نگهداری می‌شوند. [سیاست مستندات](../CONTRIBUTING.fa.md#documentation-policy-fa) را در [CONTRIBUTING.fa.md](../CONTRIBUTING.fa.md) ببینید.

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

</div>
