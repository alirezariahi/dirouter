[English](deploy-production.md) · [فارسی](deploy-production.fa.md)

<div dir="rtl">

# استقرار production

این راهنما استقرار روی **یک سرور لینوکسی با Docker Compose** را از صفر تا ارتقا و بازیابی پوشش می‌دهد. مسیرهای فرضی: کد در `/opt/dirouter`، دامنهٔ نمونه `example.com`، و کاربر SSH دارای sudo. مسیر/دامنه را در همهٔ دستورها با مقدار واقعی عوض کنید.

> پیش از انتشار: [مرجع کامل env](env-reference.fa.md) را بخوانید. اسناد `code/README.md` و `code/CI.md` نیز مرجع ساخت و انتشار image هستند. این راهنما secret واقعی تولید یا چاپ نمی‌کند.

## ۱. معماری و مرز اعتماد

| سرویس         | نقش                                                          | دسترسی شبکه                                       |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Traefik       | لبهٔ HTTPS، گواهی ACME، security header و rate limit مدیریتی | پورت عمومی 80/443                                 |
| gateway       | data plane درخواست LLM                                       | `api.example.com`؛ به Postgres وصل نمی‌شود        |
| control-api   | احراز هویت و مدیریت config                                   | `admin.example.com`                               |
| dashboard     | SPA مدیریتی                                                  | `app.example.com`                                 |
| worker        | BullMQ، نوشتن usage، rollup، partition و retention           | فقط شبکهٔ داخلی؛ `/metrics` عمومی نشود            |
| PostgreSQL 17 | دادهٔ پایدار                                                 | فقط شبکهٔ `internal`                              |
| Valkey 8      | صف، limiter و pub/sub                                        | فقط شبکهٔ `internal`؛ AOF و `noeviction` فعال است |
| migrate       | اجرای یک‌بارهٔ `prisma migrate deploy`                       | قبل از control-api/worker تمام می‌شود             |

Volumeهای `pgdata`، `valkeydata`، `gateway-data` و `traefik-acme` را حذف نکنید. snapshot/outbox گیت‌وی و `acme.json` هم بخشی از state عملیاتی‌اند. `mock-provider` در production پیش‌فرض بالا نمی‌آید؛ profile `mock` را روی سرور واقعی فعال نکنید.

## ۲. آماده‌سازی سرور

### منابع و سیستم

برای شروع حداقل ۲ vCPU، ۴GB RAM، دیسک SSD پایدار و Ubuntu 24.04 LTS (یا لینوکس پشتیبانی‌شدهٔ Docker) پیشنهاد می‌شود. حدود resource در Compose فقط نقطهٔ شروع است و تضمین ظرفیت نیست. RAM/دیسک را بر اساس نرخ درخواست، مدت stream، نگهداری لاگ و رشد PostgreSQL اندازه بگیرید. swap و زمان سیستم (NTP) را بررسی کنید.

کاربر جدا برای استقرار بسازید، SSH password login را خاموش و فقط کلید مجاز کنید، firewall را فعال کنید و فقط SSH (ترجیحاً محدود به IP مدیر)، 80 و 443 را باز بگذارید. نمونهٔ Ubuntu:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Docker را از [مخزن رسمی Docker](https://docs.docker.com/engine/install/) نصب کنید، نه image/پکیج ناشناس. نیاز است Docker Engine و plugin `docker compose` هر دو کار کنند:

```bash
docker version
docker compose version
sudo usermod -aG docker "$USER"   # logout/login لازم است
```

عضویت گروه `docker` عملاً دسترسی root است؛ فقط به حساب استقرار مورد اعتماد بدهید. برای سرور اشتراکی از rootless Docker یا کنترل سخت‌گیرانهٔ sudo استفاده کنید.

### کد و فایل‌های عملیاتی

نسخهٔ کد/Compose/پیکربندی Traefik باید با image منتشرشده سازگار باشد. برای tag نسخه `vX.Y.Z`:

```bash
sudo mkdir -p /opt/dirouter
sudo chown "$USER":"$USER" /opt/dirouter
git clone <repository-url> /opt/dirouter
cd /opt/dirouter
git checkout --detach vX.Y.Z   # یا commit ثابت و بررسی‌شده
```

اگر checkout ریشهٔ پروژه شامل `code/` است، `cd code` کنید و بقیهٔ دستورها را همان‌جا اجرا کنید. تغییرات محلی سرور را در Git نگه ندارید؛ config ثابت را از طریق release به‌روزرسانی کنید و فقط `.env` و backupها محلی/محرمانه بمانند.

## ۳. DNS

قبل از `up` رکوردهای زیر را به IP عمومی سرور برسانید (A برای IPv4 و در صورت پشتیبانی واقعی AAAA برای IPv6):

| نام                   | هدف                                                   |
| --------------------- | ----------------------------------------------------- |
| `api.example.com`     | gateway                                               |
| `admin.example.com`   | control-api                                           |
| `app.example.com`     | داشبورد                                               |
| `traefik.example.com` | داشبورد Traefik؛ فقط در صورت نیاز و با محدودیت دسترسی |

از CNAME به hostname سرور هم می‌توانید استفاده کنید. CDN/proxy جلوی HTTP-01 مانع نشود؛ مسیر `/.well-known/acme-challenge/` باید به Traefik برسد. TTL را پیش از migration کوتاه کنید و مطمئن شوید AAAA اشتباه به سرور دیگری اشاره نمی‌کند.

```bash
dig +short A api.example.com
dig +short A admin.example.com
dig +short A app.example.com
# از بیرون سرور هم بررسی کنید؛ NAT hairpin ممکن است تست داخلی را گمراه کند.
```

## ۴. پیکربندی و رازها

روی سرور و در دایرکتوری `code/`:

```bash
./scripts/bootstrap.sh --domain example.com --prod
chmod 600 .env
```

سپس `.env` را با ویرایشگر امن باز و حداقل موارد زیر را کنترل کنید:

```dotenv
DOMAIN=example.com
NODE_ENV=production
ACME_EMAIL=ops@example.com
REGISTRY=ghcr.io/<owner>/<repository>
TAG=sha-<full-commit-sha>       # یا X.Y.Z منتشرشده؛ latest نه
GATEWAY_REPLICAS=2
DASHBOARD_ORIGIN=https://app.example.com
SMTP_URL=                       # یا URL واقعی SMTP
SMTP_FROM="DiRouter <noreply@example.com>"
TRAEFIK_DASHBOARD_USERS=
TRAEFIK_ALLOW_IPS=203.0.113.10/32  # IP/VPN مدیر؛ مثال را عوض کنید
```

`bootstrap.sh` رمز PostgreSQL، `MASTER_KEY`، `KEY_PEPPER`، `JWT_SECRET` و `INTERNAL_TOKEN` مستقل و تصادفی می‌سازد. `--force` روی production رازها را بازنویسی می‌کند و می‌تواند credentialهای رمزشده/کلیدهای مجازی/نشست‌ها را خراب کند؛ **آن را روی نصب موجود اجرا نکنید.**

برای تغییر دستی، هر راز را از CSPRNG بسازید؛ از رمز مشترک یا عبارت قابل حدس استفاده نکنید. قالب keyring و طول‌های حداقلی در [env-reference](env-reference.fa.md) آمده است. `.env` را در Git، ticket، chat، لاگ CI یا backup عمومی نگذارید. فایل را به فروشنده/مدیر secrets منتقل کنید و یک نسخهٔ **رمزشده و جدا از سرور** از آن نگه دارید؛ بازیابی DB بدون `MASTER_KEY` و `KEY_PEPPER` کامل نیست.

اعتبارسنجی بدون نمایش راز:

```bash
docker compose -f compose.yaml -f compose.prod.yaml config --quiet
node scripts/ci/check-env-docs.mjs  # اگر Node روی سرور نصب است؛ اجرای آن در CI هم کافی است
```

### داشبورد Traefik

برای دسترسی، `TRAEFIK_DASHBOARD_USERS` را با bcrypt htpasswd بسازید. هر `$` در `.env` باید به شکل `$$` نوشته شود تا Compose interpolation نکند:

```bash
htpasswd -nbB admin '<strong-unique-password>'
# خروجی را در .env بگذارید و هر $ را به $$ تبدیل کنید.
# TRAEFIK_DASHBOARD_USERS=admin:$$2y$$05$$...
```

هم Basic Auth و هم `TRAEFIK_ALLOW_IPS` لازم است. اگر به داشبورد نیاز ندارید، رکورد DNS آن را نسازید و آن را از اینترنت در دسترس نگذارید. `/metrics` worker و متریک/ping Traefik روی شبکهٔ داخلی‌اند؛ scrape را فقط با override محلی/شبکهٔ مانیتورینگ امن انجام دهید.

### TLS

پیکربندی production از Let's Encrypt با HTTP-01 استفاده می‌کند؛ 80 عمومی باید باز و DNS صحیح باشد. HTTP به HTTPS ریدایرکت می‌شود و گواهی‌ها در volume `traefik-acme` (`/acme/acme.json`) ذخیره می‌شوند. ایمیل ACME را پر کنید و rate limit ثبت/صدور Let's Encrypt را با retryهای بی‌رویه مصرف نکنید.

برای wildcard یا DNS-01، `deploy/traefik/traefik.yml` را آگاهانه تغییر دهید، provider را فعال و فقط راز API همان provider را به Traefik بدهید. این راز جزء env اپ نیست و به سرویس‌های دیگر تزریق نشود. گواهی/راز DNS را در Git commit نکنید. HSTS فعلی یک‌ساله با subdomain و preload است؛ قبل از preload همهٔ زیردامنه‌های HTTPS را بررسی کنید.

## ۵. انتشار image

دو مسیر وجود دارد:

### الف) imageهای CI (ترجیحی)

CI روی push به `main` تگ `sha-<full-sha>` و روی tag معتبر `vX.Y.Z` تگ SemVer را در GHCR منتشر می‌کند. imageها شامل `gateway`، `control-api`، `worker`، `dashboard`، `mock-provider` و `migrate` هستند. `latest` تولید نمی‌شود.

```bash
export TAG=sha-<full-commit-sha>
# اگر packageها private هستند، token فقط read:packages و با حساب کم‌صلاحیت:
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io -u '<github-user>' --password-stdin
# TAG را هم در .env بنویسید، نه فقط shell فعلی.
docker compose -f compose.yaml -f compose.prod.yaml pull
```

token را در history، `.env` عمومی یا command line ساده نگذارید. بعد از pull می‌توانید logout کنید؛ credential ذخیره‌شدهٔ Docker را محافظت کنید.

### ب) build روی سرور/ماشین انتشار

اگر registry ندارید، `make build` همهٔ imageها (از جمله migrate) را محلی می‌سازد و `TAG` ثابت انتخاب کنید. برای push به registry از `make push` استفاده کنید. هرگز تصادفی `latest` را با image قدیمی مخلوط نکنید.

## ۶. استقرار اولیه و migration

ابتدا backup/نگهدارندهٔ رازها را آماده کنید. در نصب خالی، Compose خودش `migrate` را پیش از control-api و worker اجرا می‌کند:

```bash
cd /opt/dirouter/code   # یا ریشه‌ای که compose.yaml دارد
make prod-up
# معادل صریح:
# docker compose -f compose.yaml -f compose.prod.yaml up -d --wait
```

برای کنترل دقیق‌تر یا استقرار مجدد:

```bash
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P up -d postgres valkey
$P up --no-deps --force-recreate migrate
$P wait migrate
$P logs --no-log-prefix migrate
test "$($P ps -aq migrate | xargs docker inspect -f '{{.State.ExitCode}}')" = 0
$P up -d --wait
```

**`prisma migrate deploy` فقط migrationهای موجود را اعمال می‌کند؛ `migrate dev`، reset یا seed را در production اجرا نکنید.** migration باید در staging با snapshot نزدیک به production تست شده باشد. قبل از migration ناسازگار/حذفی backup تازه بگیرید و طرح backward-compatible/دو مرحله‌ای داشته باشید.

در نصب خالی به `https://app.example.com` بروید و wizard اولین سازمان/OWNER را تکمیل کنید. setup فقط وقتی هیچ کاربری وجود ندارد باز است؛ بلافاصله آن را انجام دهید، رمز قوی بسازید و دسترسی داشبورد/Control API را محدود نگه دارید. سپس provider credential را در داشبورد وارد و مدل/alias/virtual key بسازید. seed توسعه هیچ‌گاه راه‌اندازی production نیست.

## ۷. پذیرش و پایش

```bash
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P ps
$P logs --tail=100 traefik control-api gateway worker migrate
curl -fsS https://api.example.com/readyz
curl -fsS https://admin.example.com/healthz
curl -fsSI https://app.example.com
```

سپس یک درخواست غیر-stream و یک stream با کلید مجازی آزمایشی بزنید، ظاهرشدن usage در داشبورد را ببینید و login/refresh را بررسی کنید. certificate issuer/expiry و زنجیرهٔ TLS را با ابزار بیرونی بررسی کنید. لاگ خطای env، اتصال DB/Valkey، ACME، صف dead-letter و `forced > 0` در drain را پایش کنید.

دیسک، RAM/CPU، اتصال‌های PostgreSQL، عمق BullMQ/dead-letter، رشد volumeها، نرخ 5xx و freshness گواهی را هشدار دهید. `json-file` هر سرویس در production حداکثر ۵ فایل ۱۰MB نگه می‌دارد؛ برای ممیزی/پایش بلندمدت لاگ‌ها را به سیستم متمرکز امن ارسال کنید.

## ۸. مقیاس و ظرفیت

گیت‌وی stateless در سطح config است (snapshot روی volume و state توزیع‌شده در Valkey). حداقل دو replica نگه دارید:

```bash
# مقدار GATEWAY_REPLICAS را در .env هم به‌روزرسانی کنید تا drift نماند.
make scale n=3
# یا: $P up -d --no-recreate --scale gateway=3
```

قبل از افزایش، اتصال/ظرفیت Valkey، پهنای باند و upstream rate limit را بسنجید. replicaها روی یک میزبان volume مشترک `gateway-data` را برای snapshot/outbox و heartbeat مستقل در Valkey استفاده می‌کنند؛ در صورت اجرای چندمیزبانه باید طراحی ذخیره‌سازی outbox جدا بررسی شود. control-api و worker را بدون بررسی قفل/ظرفیت، با دستور عمومی scale نکنید: worker schedulerها را idempotent می‌سازد ولی pool DB و مصرف صف را چندبرابر می‌کند؛ control-api چند replica به load balancing و نشست‌های stateless تکیه دارد ولی این چیدمان پیش‌فرض تست‌شده نیست.

Postgres/Valkey تک‌نود این Compose هستند. برای HA واقعی باید managed database/Redis-compatible یا طراحی replication و failover جدا با تست recovery اضافه شود؛ صرف افزایش replica کانتینرهای stateful روی یک volume HA نیست.

## ۹. ارتقا و rollback

1. release note و diff migration را بخوانید؛ backup تازه و **تست restore** داشته باشید.
2. `TAG` جدید را در `.env` بنویسید و imageهای همان نسخه را pull کنید.
3. migration را اجرا و موفقیتش را کنترل کنید؛ migration حذفی ممکن است rollback image قدیمی را ناسازگار کند.
4. control-api/worker/dashboard را به‌روزرسانی کنید و سپس gateway را با روش rolling [runbook](runbook.fa.md) جایگزین کنید. روش runbook را ترجیح دهید تا همهٔ replicaها هم‌زمان drain نشوند.
5. پذیرش بخش ۷ را تکرار کنید.

```bash
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P pull
$P up --no-deps --force-recreate migrate
$P wait migrate
test "$($P ps -aq migrate | xargs docker inspect -f '{{.State.ExitCode}}')" = 0
$P up -d --no-deps control-api worker dashboard
# سپس rolling gateway طبق runbook.md؛ `docker compose up -d` عادی را برای gateway بدون بررسی اجرا نکنید.
```

`SHUTDOWN_DRAIN_MS` و `SHUTDOWN_READY_DELAY_MS` با prefix Compose و `stop_grace_period` باید سازگار بمانند: grace از ready delay + drain + flush بیشتر باشد. جزئیات و اسکریپت rolling در [runbook.md](runbook.fa.md) است.

برای rollback، `TAG` قبلی را برگردانید و همان ترتیب سالم را اجرا کنید. **image rollback، DB rollback نیست.** اگر schema جدید با نسخهٔ قبلی ناسازگار است، از restore backup فقط با پنجرهٔ قطعی و از دست رفتن دادهٔ بعد از backup آگاه استفاده کنید یا طرح expand/contract از قبل اجرا کنید.

<a id="10-postgresql-backup-fa"></a>

## ۱۰. پشتیبان PostgreSQL

### سیاست و backup روزانه

dump logical با `pg_dump` از خود کانتینر بگیرید تا نسخهٔ client/server سازگار باشد. backupها شامل دادهٔ حساس و credential رمزشده‌اند؛ فایل را رمزنگاری، محدود و خارج سرور نگه دارید. `.env`/keyring و volumeهای ACME/gateway را جدا و امن backup بگیرید. RPO/RTO مشخص کنید؛ dump روزانه به‌تنهایی RPO صفر نمی‌دهد. برای point-in-time recovery به WAL archiving/managed Postgres نیاز است.

نمونهٔ دستی (نام فایل در shell، نه secret در تاریخ):

```bash
cd /opt/dirouter/code
set -a; . ./.env; set +a
umask 077
backup="dirouter-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose -f compose.yaml -f compose.prod.yaml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$backup"
test -s "$backup"
# sha256sum "$backup" > "$backup.sha256" و هر دو را رمزشده به ذخیره‌سازی جدا منتقل کنید.
```

خروجی stderr/خطای `pg_dump` و فشردهٔ غیرخالی را بررسی کنید. برای cron از wrapper با `set -eu`، lock، لاگ امن و انتقال اتمی استفاده کنید؛ صرف وجود cron به معنی backup سالم نیست. retention backup را جدا از `REQUEST_LOG_RETENTION_MONTHS` تعیین کنید.

### تست و بازیابی

بازیابی را دوره‌ای روی دیتابیس ایزوله اجرا کنید. دستور زیر **دیتابیس هدف را بازسازی می‌کند**؛ روی production فقط با maintenance window و تایید عملیات:

```bash
set -a; . ./.env; set +a
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P stop control-api worker gateway   # جلوی نوشتن/اتصال در حین restore
$P up -d postgres valkey
$P exec -T postgres dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
$P exec -T postgres createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"
$P exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-privileges < /secure/path/dirouter-YYYYMMDDTHHMMSSZ.dump
$P up --no-deps --force-recreate migrate
$P up -d --wait
```

برای تست بی‌خطر، نام DB موقت جدا بسازید و همان را restore کنید؛ هیچ‌گاه dump روی DB اصلی بدون برنامهٔ outage آزمایش نشود. بعد از restore تعداد جداول/رکوردهای کلیدی، migration status، login، decrypt credential، snapshot و یک درخواست آزمایشی را بررسی کنید. اگر keyring اصلی در دسترس نیست، داده‌ها restore می‌شوند ولی secretهای provider قابل decrypt نیستند؛ pepper اشتباه نیز کلیدهای مجازی را نامعتبر می‌کند.

dump شامل Valkey queue، snapshot فایل gateway یا ACME نیست. بعد از restore، config را از control-api بازسازی/همگام کنید و state صف را بررسی کنید. volumeها را با `down -v` حذف نکنید مگر تصمیم صریح به از بین بردن داده گرفته شده باشد.

## ۱۱. چرخش راز و واکنش به حادثه

- **PostgreSQL/SMTP/GHCR**: رمز را در سرویس مبدأ و سپس `.env` عوض و سرویس‌های وابسته را controlled recreate کنید. رمز DB در volume با تغییر env به‌خودی‌خود عوض نمی‌شود.
- **JWT_SECRET**: همهٔ access tokenها بی‌اعتبار می‌شوند؛ کاربران دوباره login می‌کنند.
- **INTERNAL_TOKEN**: مقدار یکسان در control-api و gateway را coordinated عوض کنید؛ در فاصلهٔ ناسازگاری snapshot/probe داخلی خطا می‌گیرد.
- **KEY_PEPPER**: تغییر سادهٔ آن کلیدهای فعلی را باطل می‌کند؛ برای چرخش، صدور کلید جایگزین و migration کاربران لازم است.
- **MASTER_KEY**: نسخهٔ جدید را به keyring اضافه و نسخهٔ قدیمی را برای decrypt نگه دارید. برای حذف کلید قدیمی، ابتدا همهٔ ciphertextها را با نسخهٔ جدید re-encrypt کنید؛ چرخش env به‌تنهایی رکوردهای DB را بازنویسی نمی‌کند.
- راز لو رفته را revoke/rotate کنید، لاگ و دسترسی‌های مشکوک را بررسی کنید و backupهای نشت‌کرده را هم آلوده بدانید.

## ۱۲. توقف امن

```bash
make prod-down       # داده و volumeها باقی می‌مانند
# ممنوع برای عملیات عادی: docker compose ... down -v
```

قبل از توقف برنامه‌ریزی‌شده ترافیک را کم کنید و از سلامت backup مطمئن شوید. در خاموشی gateway به drain و flush زمان بدهید؛ SIGKILL/`down -v`/حذف volume خارج از سناریوی disaster recovery نیست.

</div>
