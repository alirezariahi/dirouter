[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Production Deployment

This guide covers deploying on **one Linux server with Docker Compose**, from zero through upgrades and recovery. Example paths: the code in `/opt/dirouter`, the sample domain `example.com`, and an SSH user with sudo. Replace the path and domain with real values in every command.

> Before release: read the [full env reference](env-reference.md). The documents `code/README.md` and `code/CI.md` are also references for building and publishing images. This guide does not generate or print real secrets.

## 1. Architecture and trust boundary

| Service       | Role                                                                     | Network access                                        |
| ------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| Traefik       | HTTPS edge, ACME certificates, security headers, and admin rate limiting | public ports 80/443                                   |
| gateway       | Data plane for LLM requests                                              | `api.example.com`; does not connect to Postgres       |
| control-api   | Authentication and config management                                     | `admin.example.com`                                   |
| dashboard     | Management SPA                                                           | `app.example.com`                                     |
| worker        | BullMQ, usage writing, rollup, partitions, and retention                 | internal network only; `/metrics` must not be public  |
| PostgreSQL 17 | Persistent data                                                          | `internal` network only                               |
| Valkey 8      | Queue, limiter, and pub/sub                                              | `internal` network only; AOF and `noeviction` enabled |
| migrate       | One-off `prisma migrate deploy`                                          | finishes before control-api/worker                    |

Do not delete the volumes `pgdata`, `valkeydata`, `gateway-data`, and `traefik-acme`. The gateway's snapshot/outbox and `acme.json` are also part of the operational state. `mock-provider` does not start by default in production; do not enable the `mock` profile on a real server.

## 2. Server preparation

### Resources and system

For a start, at least 2 vCPU, 4GB RAM, a stable SSD disk, and Ubuntu 24.04 LTS (or another Linux distribution supported by Docker) are recommended. Resource limits in Compose are only a starting point and not a capacity guarantee. Size RAM and disk based on the request rate, stream duration, log retention, and PostgreSQL growth. Check swap and the system time (NTP).

Create a separate user for deployment, turn off SSH password login and allow only keys, enable the firewall, and open only SSH (preferably limited to the admin IP), 80, and 443. Ubuntu example:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Install Docker from the [official Docker repository](https://docs.docker.com/engine/install/), not from an unknown image or package. Both Docker Engine and the `docker compose` plugin must work:

```bash
docker version
docker compose version
sudo usermod -aG docker "$USER"   # logout/login is required
```

Membership in the `docker` group is effectively root access; give it only to a trusted deployment account. For a shared server, use rootless Docker or strict sudo controls.

### Code and operational files

The code/Compose/Traefik configuration must match the published image. For version tag `vX.Y.Z`:

```bash
sudo mkdir -p /opt/dirouter
sudo chown "$USER":"$USER" /opt/dirouter
git clone <repository-url> /opt/dirouter
cd /opt/dirouter
git checkout --detach vX.Y.Z   # or a fixed, reviewed commit
```

If the project root checkout contains `code/`, run `cd code` and execute the remaining commands there. Do not keep local server changes in Git; update the fixed configuration through a release, and keep only `.env` and the backups local and confidential.

## 3. DNS

Before `up`, point the following records to the server's public IP (an A record for IPv4, and an AAAA record for IPv6 if it is really supported):

| Name                  | Target                                                        |
| --------------------- | ------------------------------------------------------------- |
| `api.example.com`     | gateway                                                       |
| `admin.example.com`   | control-api                                                   |
| `app.example.com`     | dashboard                                                     |
| `traefik.example.com` | Traefik dashboard; only if needed and with access restriction |

You can also use a CNAME to the server's hostname. A CDN or proxy in front must not block HTTP-01; the path `/.well-known/acme-challenge/` must reach Traefik. Shorten the TTL before the migration and make sure no incorrect AAAA record points to another server.

```bash
dig +short A api.example.com
dig +short A admin.example.com
dig +short A app.example.com
# Check from outside the server too; NAT hairpinning may mislead the internal test.
```

## 4. Configuration and secrets

On the server, in the `code/` directory:

```bash
./scripts/bootstrap.sh --domain example.com --prod
chmod 600 .env
```

Then open `.env` with a secure editor and check at least the following:

```dotenv
DOMAIN=example.com
NODE_ENV=production
ACME_EMAIL=ops@example.com
REGISTRY=ghcr.io/<owner>/<repository>
TAG=sha-<full-commit-sha>       # or a published X.Y.Z; not latest
GATEWAY_REPLICAS=2
DASHBOARD_ORIGIN=https://app.example.com
SMTP_URL=                       # or a real SMTP URL
SMTP_FROM="DiRouter <noreply@example.com>"
TRAEFIK_DASHBOARD_USERS=
TRAEFIK_ALLOW_IPS=203.0.113.10/32  # admin IP/VPN; replace the example
```

`bootstrap.sh` generates independent, random values for the PostgreSQL password, `MASTER_KEY`, `KEY_PEPPER`, `JWT_SECRET`, and `INTERNAL_TOKEN`. `--force` on production overwrites the secrets and can break encrypted credentials, virtual keys, and sessions; **do not run it on an existing installation.**

For manual changes, generate every secret from a CSPRNG; do not use a shared password or a guessable phrase. The keyring template and minimum lengths are in [env-reference](env-reference.md). Do not put `.env` in Git, a ticket, chat, a CI log, or a public backup. Transfer the file to the vendor or secrets manager, and keep one **encrypted copy separate from the server**; a DB restore without `MASTER_KEY` and `KEY_PEPPER` is incomplete.

Validation without displaying secrets:

```bash
docker compose -f compose.yaml -f compose.prod.yaml config --quiet
node scripts/ci/check-env-docs.mjs  # if Node is installed on the server; running it in CI is also sufficient
```

### Traefik dashboard

To access it, build `TRAEFIK_DASHBOARD_USERS` with bcrypt htpasswd. Every `$` in `.env` must be written as `$$` so that Compose interpolation does not alter it:

```bash
htpasswd -nbB admin '<strong-unique-password>'
# Put the output in .env and convert every $ to $$.
# TRAEFIK_DASHBOARD_USERS=admin:$$2y$$05$$...
```

Both Basic Auth and `TRAEFIK_ALLOW_IPS` are required. If you do not need the dashboard, do not create its DNS record and do not expose it to the internet. The worker's `/metrics` and Traefik's metrics/ping are on the internal network; scrape them only with a local override or a secure monitoring network.

### TLS

The production configuration uses Let's Encrypt with HTTP-01; public port 80 must be open and DNS must be correct. HTTP redirects to HTTPS, and certificates are stored in the `traefik-acme` volume (`/acme/acme.json`). Fill in the ACME email, and do not exhaust Let's Encrypt registration or issuance rate limits with indiscriminate retries.

For a wildcard certificate or DNS-01, deliberately change `deploy/traefik/traefik.yml`, enable the provider, and give Traefik only the API secret of that same provider. This secret is not part of the app's env and must not be injected into other services. Do not commit certificates or DNS secrets to Git. The current HSTS policy is one year, with subdomains and preload; before preloading, check all HTTPS subdomains.

## 5. Publishing images

There are two paths:

### A) CI images (preferred)

On push to `main`, CI publishes the tag `sha-<full-sha>`, and on a valid `vX.Y.Z` tag it publishes the SemVer tag, to GHCR. The images include `gateway`, `control-api`, `worker`, `dashboard`, `mock-provider`, and `migrate`. `latest` is not produced.

```bash
export TAG=sha-<full-commit-sha>
# If the packages are private, use a token with read:packages only and a low-privilege account:
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io -u '<github-user>' --password-stdin
# Write TAG in .env too, not only in the current shell.
docker compose -f compose.yaml -f compose.prod.yaml pull
```

Do not put the token in shell history, a public `.env`, or a plain command line. After the pull you may log out; protect the credential that Docker stores.

### B) Build on the server or on a publishing machine

If you have no registry, `make build` builds all images (including migrate) locally, and you choose a fixed `TAG`. Use `make push` to push to a registry. Never accidentally mix `latest` with an old image.

## 6. Initial deployment and migration

First, prepare the backup and the keeping of the secrets. On an empty installation, Compose runs `migrate` itself before control-api and worker:

```bash
cd /opt/dirouter/code   # or the root directory that contains compose.yaml
make prod-up
# Explicit equivalent:
# docker compose -f compose.yaml -f compose.prod.yaml up -d --wait
```

For finer control or for redeployment:

```bash
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P up -d postgres valkey
$P up --no-deps --force-recreate migrate
$P wait migrate
$P logs --no-log-prefix migrate
test "$($P ps -aq migrate | xargs docker inspect -f '{{.State.ExitCode}}')" = 0
$P up -d --wait
```

**`prisma migrate deploy` applies only existing migrations; do not run `migrate dev`, reset, or seed in production.** A migration must be tested in staging with a snapshot close to production. Before an incompatible or destructive migration, take a fresh backup and have a backward-compatible or two-step plan.

On an empty installation, go to `https://app.example.com` and complete the wizard for the first organization and OWNER. Setup is open only while no user exists; do it immediately, create a strong password, and keep dashboard and Control API access restricted. Then enter the provider credential in the dashboard and create the model, alias, and virtual key. The development seed is never a production startup.

## 7. Acceptance and monitoring

```bash
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P ps
$P logs --tail=100 traefik control-api gateway worker migrate
curl -fsS https://api.example.com/readyz
curl -fsS https://admin.example.com/healthz
curl -fsSI https://app.example.com
```

Then send one non-streaming request and one streaming request with a test virtual key, check that the usage appears in the dashboard, and verify login and refresh. Check the certificate issuer, its expiry, and the TLS chain with an external tool. Monitor env errors, database and Valkey connections, ACME, the dead-letter queue, and `forced > 0` during drain.

Alert on disk usage, RAM/CPU, PostgreSQL connections, BullMQ and dead-letter depth, volume growth, the 5xx rate, and certificate freshness. The `json-file` logs of each service keep at most 5 files of 10MB in production; for long-term auditing and monitoring, send logs to a secure central system.

## 8. Scale and capacity

The gateway is stateless at the config level (the snapshot is on a volume and the distributed state is in Valkey). Keep at least two replicas:

```bash
# Also update GATEWAY_REPLICAS in .env so that it does not drift.
make scale n=3
# or: $P up -d --no-recreate --scale gateway=3
```

Before increasing replicas, measure the Valkey connection capacity, bandwidth, and the upstream rate limit. Replicas on one host share the `gateway-data` volume for the snapshot and outbox, and use independent heartbeats in Valkey; in a multi-host setup, the storage design for the outbox must be reviewed separately. Do not scale control-api and worker with the generic scale command without checking locks and capacity: worker makes the schedulers idempotent but multiplies the DB pool and queue consumption; control-api with several replicas relies on load balancing and stateless sessions, but this layout is not the default tested setup.

The Postgres and Valkey in this Compose file are single-node. For real HA you must add a managed database or Redis-compatible service, or a separate replication and failover design with recovery tests; simply adding replicas of stateful containers on one volume is not HA.

## 9. Upgrade and rollback

1. Read the release notes and the migration diff; have a fresh backup and a **restore test**.
2. Write the new `TAG` into `.env` and pull the images of that same version.
3. Run the migration and check that it succeeded; a destructive migration may make rolling back to the old image incompatible.
4. Update control-api, worker, and dashboard, then replace the gateway with the rolling method in the [runbook](runbook.md). Prefer the runbook method so that all replicas are not drained at the same time.
5. Repeat the acceptance steps in section 7.

```bash
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P pull
$P up --no-deps --force-recreate migrate
$P wait migrate
test "$($P ps -aq migrate | xargs docker inspect -f '{{.State.ExitCode}}')" = 0
$P up -d --no-deps control-api worker dashboard
# Then roll the gateway according to runbook.md; do not run a plain `docker compose up -d` for the gateway without checks.
```

`SHUTDOWN_DRAIN_MS` and `SHUTDOWN_READY_DELAY_MS` with the Compose prefix and `stop_grace_period` must remain compatible: the grace period must be greater than the ready delay + drain + flush time. Details and the rolling script are in [runbook.md](runbook.md).

For a rollback, restore the previous `TAG` and run the same healthy sequence. **Rolling back the image is not a DB rollback.** If the new schema is incompatible with the previous version, use a restore from backup only with a planned outage window and awareness of the data lost after the backup, or run an expand/contract plan in advance.

## 10. PostgreSQL backup

### Policy and daily backup

Take a logical dump with `pg_dump` from the container itself so that the client and server versions match. Backups contain sensitive data and encrypted credentials; encrypt them, restrict access, and keep them off the server. Back up `.env`/keyring and the ACME and gateway volumes separately and securely. Define your RPO and RTO; a daily dump alone does not give an RPO of zero. Point-in-time recovery requires WAL archiving or a managed Postgres.

Manual example (the file name is in the shell, not a secret in the history):

```bash
cd /opt/dirouter/code
set -a; . ./.env; set +a
umask 077
backup="dirouter-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose -f compose.yaml -f compose.prod.yaml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$backup"
test -s "$backup"
# sha256sum "$backup" > "$backup.sha256" and transfer both, encrypted, to separate storage.
```

Check the stderr and error output of `pg_dump`, and that the compressed output is non-empty. For cron, use a wrapper with `set -eu`, a lock, safe logging, and atomic transfer; the mere existence of a cron job does not mean the backup is healthy. Define backup retention separately from `REQUEST_LOG_RETENTION_MONTHS`.

### Testing and restore

Run the restore periodically on an isolated database. The following commands **rebuild the target database**; on production, run them only in a maintenance window and with operational approval:

```bash
set -a; . ./.env; set +a
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P stop control-api worker gateway   # prevent writes and connections during the restore
$P up -d postgres valkey
$P exec -T postgres dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
$P exec -T postgres createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"
$P exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-privileges < /secure/path/dirouter-YYYYMMDDTHHMMSSZ.dump
$P up --no-deps --force-recreate migrate
$P up -d --wait
```

For a safe test, create a separate temporary database name and restore into it; never test a dump on the main database without an outage plan. After the restore, check the number of key tables and records, the migration status, login, credential decryption, the snapshot, and one test request. If the original keyring is unavailable, the data is restored but the provider secrets cannot be decrypted; a wrong pepper also invalidates virtual keys.

A dump does not include the Valkey queue, the gateway's file snapshot, or ACME. After a restore, rebuild and sync the config from control-api and check the queue state. Do not remove volumes with `down -v` unless the decision to destroy data has been explicitly made.

## 11. Secret rotation and incident response

- **PostgreSQL / SMTP / GHCR**: change the password in the source service and then in `.env`, and perform a controlled recreation of the dependent services. The DB password in the volume does not change by itself when the env value changes.
- **JWT_SECRET**: all access tokens become invalid; users sign in again.
- **INTERNAL_TOKEN**: change the identical value in control-api and gateway in a coordinated way; during the mismatch window, snapshot and internal probe requests will fail.
- **KEY_PEPPER**: a simple change invalidates the current keys; for rotation, issue replacement keys and migrate the users.
- **MASTER_KEY**: add the new version to the keyring and keep the old version for decryption. To remove the old key, first re-encrypt all ciphertexts with the new version; rotating the env alone does not rewrite the DB records.
- Revoke or rotate any leaked secret, review logs and suspicious access, and treat leaked backups as compromised too.

## 12. Safe shutdown

```bash
make prod-down       # data and volumes remain
# Forbidden for normal operations: docker compose ... down -v
```

Before a planned shutdown, reduce traffic and make sure the backup is healthy. During shutdown, give the gateway time to drain and flush; SIGKILL, `down -v`, and volume deletion are only acceptable within a disaster-recovery scenario.

---

<a id="persian"></a>

# استقرار production

این راهنما استقرار روی **یک سرور لینوکسی با Docker Compose** را از صفر تا ارتقا و بازیابی پوشش می‌دهد. مسیرهای فرضی: کد در `/opt/dirouter`، دامنهٔ نمونه `example.com`، و کاربر SSH دارای sudo. مسیر/دامنه را در همهٔ دستورها با مقدار واقعی عوض کنید.

> پیش از انتشار: [مرجع کامل env](env-reference.md) را بخوانید. اسناد `code/README.md` و `code/CI.md` نیز مرجع ساخت و انتشار image هستند. این راهنما secret واقعی تولید یا چاپ نمی‌کند.

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

برای تغییر دستی، هر راز را از CSPRNG بسازید؛ از رمز مشترک یا عبارت قابل حدس استفاده نکنید. قالب keyring و طول‌های حداقلی در [env-reference](env-reference.md) آمده است. `.env` را در Git، ticket، chat، لاگ CI یا backup عمومی نگذارید. فایل را به فروشنده/مدیر secrets منتقل کنید و یک نسخهٔ **رمزشده و جدا از سرور** از آن نگه دارید؛ بازیابی DB بدون `MASTER_KEY` و `KEY_PEPPER` کامل نیست.

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
4. control-api/worker/dashboard را به‌روزرسانی کنید و سپس gateway را با روش rolling [runbook](runbook.md) جایگزین کنید. روش runbook را ترجیح دهید تا همهٔ replicaها هم‌زمان drain نشوند.
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

`SHUTDOWN_DRAIN_MS` و `SHUTDOWN_READY_DELAY_MS` با prefix Compose و `stop_grace_period` باید سازگار بمانند: grace از ready delay + drain + flush بیشتر باشد. جزئیات و اسکریپت rolling در [runbook.md](runbook.md) است.

برای rollback، `TAG` قبلی را برگردانید و همان ترتیب سالم را اجرا کنید. **image rollback، DB rollback نیست.** اگر schema جدید با نسخهٔ قبلی ناسازگار است، از restore backup فقط با پنجرهٔ قطعی و از دست رفتن دادهٔ بعد از backup آگاه استفاده کنید یا طرح expand/contract از قبل اجرا کنید.

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
