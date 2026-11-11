[English](env-reference.md) · [فارسی](env-reference.fa.md)

<div dir="rtl">

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

راهنمای اجرا و جزئیات امنیتی در [monitoring.md](monitoring.fa.md) است.

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

</div>
