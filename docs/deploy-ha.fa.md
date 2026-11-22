[English](deploy-ha.md) · [فارسی](deploy-ha.fa.md)

<div dir="rtl">

# استقرار با دسترس‌پذیری بالا (کارت ۱۷.۳)

> فایل‌ها: [`compose.ha.yaml`](../compose.ha.yaml)، `deploy/ha/postgres/`، `deploy/ha/valkey/` و `scripts/backup/`. ابتدا [deploy-production.fa.md](deploy-production.fa.md) را بخوانید؛ این صفحه فقط چیزهایی را می‌گوید که overlay مربوط به HA اضافه می‌کند.

> **وضعیت.** لایهٔ دادهٔ overlay (primary و standby برای PostgreSQL، و primary + ۲ replica + ۳ sentinel برای Valkey) در 2026-11-20 به‌صورت یک پروژهٔ Compose جدا روی یک میزبان راه‌اندازی و آزموده شد (macOS Docker Desktop، ۴ CPU و ۴ گیگابایت حافظه، working tree اسپرینت ۲)؛ نتیجه‌ها در بخش [ثبت تمرین‌ها](#ثبت-تمرینها) در انتهای همین صفحه است. در 2026-11-21 کل overlay با ایمیج‌های production (۳ replica گیت‌وی، ۲ control-api و ۲ worker) بالا آمد و بدون Traefik، با صدا زدن مستقیم هر replica، آزموده شد. **هنوز آزموده نشده:** overlay پشت Traefik (توزیع بار و سهم درخواست‌هایی که با از دست رفتن یک replica گیت‌وی از بین می‌رود)، سرویس جانبی rclone در profile با نام `backup-s3`، و تمرین بازیابی نقطه‌ای (PITR). این‌ها را اول روی میزبانی غیر از production تمرین کنید و نتیجه را به جدول‌های ثبت اضافه کنید.

## توپولوژی

```
                    Traefik
                       │
        ┌──────────────┼──────────────┐
   gateway ×3     control-api ×2    dashboard
        │              │
        │        ┌─────┴──────┐
        │    postgres ──► postgres-standby   (streaming replication, manual promotion)
        │
   valkey (primary) ──► valkey-replica-1, valkey-replica-2
        ▲
   valkey-sentinel ×3  (quorum 2, automatic failover)          worker ×2
```

| جزء         | افزونگی                                                           | Failover                         |
| ----------- | ----------------------------------------------------------------- | -------------------------------- |
| gateway     | ۳ replica بدون state پشت Traefik                                  | خودکار (health check هر ۲ ثانیه) |
| control-api | ۲ replica؛ ساخت snapshot با advisory lock دیتابیس                 | خودکار                           |
| worker      | ۲ replica؛ schedulerها upsert می‌شوند و هر job یک بار اجرا می‌شود | خودکار                           |
| Valkey      | primary + ۲ replica + ۳ sentinel                                  | خودکار، حدود ۵ تا ۱۵ ثانیه       |
| PostgreSQL  | primary + hot standby                                             | **ارتقای دستی** (runbook پایین)  |
| بکاپ        | `pg_dump` روزانه، base backup و آرشیو WAL                         | تمرین بازیابی و PITR (پایین)     |

یک میزبان Docker در برابر خرابی پردازه و کانتینر مقاوم است، نه از دست رفتن خود میزبان. برای دسترس‌پذیری در سطح میزبان، همین سرویس‌ها را روی چند میزبان (Swarm یا Kubernetes) اجرا کنید یا از PostgreSQL و Valkey مدیریت‌شده استفاده کنید؛ تنظیم‌های برنامه همان است.

## راه‌اندازی

```bash
# افزودنی‌های .env
REPLICATION_PASSWORD=<مقدار تصادفی بلند>   # برای overlay الزامی است؛ مثلاً openssl rand -hex 24
# اختیاری: HA_GATEWAY_REPLICAS=3 HA_CONTROL_API_REPLICAS=2 HA_WORKER_REPLICAS=2
# اختیاری: HA_IP_PREFIX=10.89.250          # subnet شبکهٔ internal؛ بخش «نشانی ثابت» را ببینید

C="docker compose -f compose.yaml -f compose.prod.yaml -f compose.ha.yaml"
$C up -d
./scripts/backup/pg-basebackup.sh          # اولین base backup؛ بخش «آرشیو WAL» را ببینید
```

overlay متغیرهای replica خودش را دارد. `GATEWAY_REPLICAS` متعلق به `compose.prod.yaml` است و اینجا نادیده گرفته می‌شود؛ پس مقداری که در `.env` مانده نمی‌تواند پیش‌فرض سه گیت‌وی در HA را کم کند. فهرست همهٔ متغیرها در [env-reference.fa.md](env-reference.fa.md) است.

- **دیتابیس جدید**: نقش replication، replication slot آن و خط `pg_hba.conf` را اسکریپت init می‌سازد.
- **دیتابیس موجود**: اسکریپت‌های init روی volume دارای داده اجرا نمی‌شوند. اول primary را با overlay دوباره بسازید (اسکریپت و `REPLICATION_PASSWORD` فقط در آن کانتینر هستند) و بعد اسکریپت را یک بار اجرا کنید:

  ```bash
  $C up -d --no-deps postgres
  $C exec -u postgres postgres sh /docker-entrypoint-initdb.d/10-replication.sh
  $C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT pg_reload_conf()'
  $C up -d
  ```

  ساخت دوبارهٔ primary یک قطعی کوتاه control plane است (`archive_mode` ری‌استارت می‌خواهد)؛ گیت‌وی سرویس می‌دهد. Valkey هم دوباره ساخته می‌شود و داده‌اش را نگه می‌دارد.

- **stack موجود بدون overlay**: overlay به شبکهٔ internal یک subnet ثابت می‌دهد و Docker آن را فقط هنگام ساخت شبکه اعمال می‌کند. پیش از اولین راه‌اندازی با overlay، یک بار stack را متوقف و شبکهٔ `<project>_internal` را حذف کنید؛ بخش [نشانی ثابت برای Valkey و sentinelها](#نشانی-ثابت-برای-valkey-و-sentinelها) را ببینید.

بررسی replication:

```bash
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT client_addr, state, sync_state, replay_lag FROM pg_stat_replication'
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT slot_name, active, wal_status, safe_wal_size FROM pg_replication_slots'
$C exec postgres-standby psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_is_in_recovery()'   # t
$C exec valkey-sentinel-1 valkey-cli -p 26379 sentinel get-master-addr-by-name dirouter
```

### standby و replication slot آن

standby در اولین شروع، primary را clone می‌کند (`deploy/ha/postgres/standby-entrypoint.sh`). clone کنار پوشهٔ داده نوشته می‌شود و فقط وقتی کامل شد تغییر نام می‌گیرد؛ پس clone نیمه‌کاره به‌سادگی تکرار می‌شود. replication slot با نام `dirouter_standby` پیش از هر clone حذف و دوباره ساخته می‌شود؛ بنابراین slot به‌جامانده از یک تلاش نیمه‌کاره جلوی تلاش بعدی را نمی‌گیرد.

slot باعث می‌شود primary آن WALی را که standby هنوز نگرفته نگه دارد. `max_slot_wal_keep_size` (متغیر `POSTGRES_MAX_SLOT_WAL_KEEP_SIZE`، پیش‌فرض `2GB`) برای آن سقف می‌گذارد: standbyای که مدت طولانی خاموش بماند دیسک primary را پر نمی‌کند. بعد از عبور از سقف، slot مقدار `wal_status = lost` نشان می‌دهد؛ standby تا جایی که بتواند از آرشیو WAL جلو می‌آید، ولی برای streaming باید دوباره clone شود:

```bash
$C rm -sf postgres-standby
docker volume rm dirouter_pgdata-standby     # <نام پروژه>_pgdata-standby
$C up -d postgres-standby
```

## Valkey با Sentinel

برنامه‌ها `VALKEY_URL=redis+sentinel://valkey-sentinel-1:26379,valkey-sentinel-2:26379,valkey-sentinel-3:26379/dirouter` می‌گیرند. کلاینت primary فعلی را از sentinelها می‌پرسد و بعد از failover خودش دوباره وصل می‌شود؛ چیزی نیاز به پیکربندی دوباره ندارد. قالب:

```
redis+sentinel://[:password@]host1:26379,host2:26379,host3:26379/<primary name>[/db]
```

هر گرهٔ داده پیکربندی‌اش را در `/data/valkey.conf` و هر sentinel در `/data/sentinel.conf` نگه می‌دارد؛ هر دو روی named volume هستند و فقط در اولین شروع نوشته می‌شوند (`deploy/ha/valkey/`). Sentinel نتیجهٔ failover را در همین فایل‌ها ثبت می‌کند؛ پس sentinel بعد از ری‌استارت هنوز primary فعلی را می‌شناسد و گره‌ای که replica شده replica می‌ماند. هر گرهٔ داده پیش از شروع از sentinelها هم می‌پرسد: primary قبلی که هنگام failover خاموش بوده، به‌عنوان replica برای primary جدید برمی‌گردد و هیچ‌وقت به‌عنوان primary دوم نوشتن نمی‌پذیرد. گره‌ها و sentinelها نشانی ثابت خود روی شبکهٔ internal را اعلام می‌کنند، نه نام سرویس را (بخش بعد).

### نشانی ثابت برای Valkey و sentinelها

گره‌های Valkey و sentinelها روی شبکهٔ internal نشانی ثابت دارند و همان نشانی را اعلام می‌کنند (`replica-announce-ip` و `sentinel announce-ip`)؛ sentinelها primary را هم با نشانی پایش می‌کنند.

| سرویس               | نشانی                |
| ------------------- | -------------------- |
| `valkey`            | `${HA_IP_PREFIX}.11` |
| `valkey-replica-1`  | `${HA_IP_PREFIX}.12` |
| `valkey-replica-2`  | `${HA_IP_PREFIX}.13` |
| `valkey-sentinel-1` | `${HA_IP_PREFIX}.21` |
| `valkey-sentinel-2` | `${HA_IP_PREFIX}.22` |
| `valkey-sentinel-3` | `${HA_IP_PREFIX}.23` |

- **چرا نام سرویس نه.** وقتی کانتینر primary متوقف می‌شود، DNS داکر دیگر نام آن را resolve نمی‌کند. sentinelی که نامی را پایش می‌کند که resolve نمی‌شود به حالت TILT می‌رود و هیچ‌وقت failover نمی‌کند؛ اولین تست failover دقیقاً همین را نشان داد (بعد از ۱۳۲ ثانیه هنوز failover نشده بود). با نشانی، همان تست در چند ثانیه failover می‌کند (ثبت تمرین‌ها را ببینید).
- **`HA_IP_PREFIX`** (پیش‌فرض `10.89.250`) سه بخش اول نشانی شبکهٔ internal است که `${HA_IP_PREFIX}.0/24` می‌شود. اگر این subnet با شبکهٔ دیگری روی میزبان تداخل دارد آن را عوض کنید.
- **نکتهٔ به‌روزرسانی.** subnet هنگام ساخت شبکهٔ `<project>_internal` اعمال می‌شود. میزبانی که از قبل stack را بدون overlay اجرا می‌کند این شبکه را با subnet دیگری دارد؛ پس یک بار stack را متوقف و شبکه را حذف کنید:

  ```bash
  docker compose -f compose.yaml -f compose.prod.yaml down      # volumeها می‌مانند
  docker network rm dirouter_internal                           # <project>_internal، اگر هنوز وجود دارد
  $C up -d
  ```

- **برنامه‌ها هنوز با نام سرویس** به sentinelها وصل می‌شوند (`redis+sentinel://valkey-sentinel-1:26379,…/dirouter`). این مشکلی ندارد: کلاینت فقط باید به یک sentinel در حال اجرا برسد و sentinelها نشانی primary فعلی را برمی‌گردانند.

```bash
$C exec valkey-sentinel-1 valkey-cli -p 26379 sentinel replicas dirouter | grep -A1 -E '^(name|flags)$'
$C exec valkey valkey-cli info replication | grep -E '^(role|master_host|master_link_status|connected_slaves)'
$C exec valkey-sentinel-1 valkey-cli -p 26379 sentinel failover dirouter     # جابه‌جایی برنامه‌ریزی‌شده
```

برای برگشت به چینش اولیه (`valkey` به‌عنوان primary) از `sentinel failover` استفاده کنید؛ volume مربوط به sentinelهای یک گروه در حال کار را حذف نکنید، چون sentinel بدون state حتی وقتی `valkey` خودش replica است آن را پایش می‌کند.

در ۵ تا ۱۵ ثانیهٔ failover، گیت‌وی مثل قطعی Valkey رفتار می‌کند: rate limiter به حالت محلی می‌رود (`failMode: open`) و رویدادهای مصرف در outbox روی دیسک می‌مانند و بعد replay می‌شوند. replication ناهمگام است؛ پس چند نوشتن آخر پیش از خرابی (شمارنده‌های limiter و رویدادهای مصرفی که هنوز replicate نشده‌اند) ممکن است از دست برود. رویدادهای مصرف تا زمان تأیید در outbox گیت‌وی هم هستند.

## Runbook failover برای PostgreSQL

گیت‌وی از PostgreSQL استفاده نمی‌کند. تا وقتی دیتابیس قطع است **ترافیک LLM ادامه دارد**؛ داشبورد و API در دسترس نیستند و رویدادهای مصرف در صف می‌مانند.

**چه زمانی ارتقا دهیم:** primary قطع است و زود برنمی‌گردد، یا volume آن از دست رفته است. اگر فقط در حال ری‌استارت است صبر کنید؛ ارتقا برگشت‌پذیر نیست.

1. مطمئن شوید primary واقعاً قطع است و آن را متوقف کنید تا به‌عنوان primary دوم برنگردد:
   ```bash
   $C stop postgres
   ```
2. ببینید standby تا کجا رسیده (تراکنش‌های بعد از این نقطه از دست می‌روند):
   ```bash
   $C exec postgres-standby psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_last_wal_replay_lsn(), now() - pg_last_xact_replay_timestamp()'
   ```
3. ارتقا:
   ```bash
   $C exec postgres-standby psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_promote()'   # t
   $C exec postgres-standby psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_is_in_recovery()'   # f
   ```
4. برنامه‌ها را به آن وصل و دوباره بسازید. `--no-deps` مهم است: بدون آن Compose دوباره primary قدیمی را راه می‌اندازد، چون برنامه‌ها به سرویس `postgres` وابسته‌اند:
   ```bash
   # .env
   POSTGRES_HOST=postgres-standby
   $C up -d --no-deps control-api worker
   ```
5. بررسی: `GET /readyz` در control-api، یک ورود، یک تغییر config که به گیت‌وی‌ها برسد (`configVersion` در صفحهٔ «سلامت») و خالی شدن صف مصرف.
6. بازسازی افزونگی: primary قدیمی را به همان شکل **راه نیندازید**. volume آن را حذف کنید و به‌عنوان standby برای primary جدید برگردانید (نقش دو سرویس را جابه‌جا کنید یا با `pg_basebackup` دوباره clone بگیرید). standby ارتقایافته WAL را در همان آرشیو قبلی آرشیو می‌کند؛ بلافاصله از آن یک base backup تازه بگیرید: `PG_SERVICE=postgres-standby ./scripts/backup/pg-basebackup.sh`.

هدف: گام‌های ۱ تا ۵ در کمتر از ۱۰ دقیقه. دادهٔ ازدست‌رفته برابر با تأخیر replication در لحظهٔ خرابی است (replication ناهمگام؛ معمولاً خیلی کمتر از یک ثانیه).

## بکاپ

replication بکاپ نیست: یک `DELETE` اشتباه همان لحظه replicate می‌شود. دو نوع بکاپ مکمل هم هستند:

| نوع                        | اسکریپت                               | به کجا برمی‌گرداند                | زمان‌بندی معمول  |
| -------------------------- | ------------------------------------- | --------------------------------- | ---------------- |
| dump منطقی (`pg_dump`)     | `scripts/backup/pg-backup.sh`         | لحظهٔ گرفتن dump                  | روزانه           |
| base backup + WAL آرشیوشده | `scripts/backup/pg-basebackup.sh`     | هر لحظه بعد از base backup        | هفتگی؛ WAL همیشه |
| تمرین بازیابی dump         | `scripts/backup/pg-restore-verify.sh` | یک دیتابیس موقت که بعد حذف می‌شود | ماهانه           |

```bash
./scripts/backup/pg-backup.sh /var/backups/dirouter        # روزانه، با cron
./scripts/backup/pg-basebackup.sh                          # هفتگی، با cron
./scripts/backup/pg-restore-verify.sh /var/backups/dirouter/dirouter-<timestamp>.dump   # ماهانه
```

- `pg-backup.sh` یک `pg_dump` فشرده و SHA-256 آن را می‌نویسد و تا کامل نشدن، نام موقت دارد؛ اگر dump شکست بخورد، خالی باشد یا فهرست محتوای خوانا نداشته باشد با کد غیرصفر خارج می‌شود. با overlay مربوط به HA می‌توانید آن را از standby بگیرید (`PG_SERVICE=postgres-standby`) تا باری روی primary نیاید؛ dump طولانی روی standby ممکن است به خاطر replay لغو شود که در آن صورت روی primary اجرا کنید. فایل را رمز و از میزبان خارج کنید و `.env` (keyring) را هم جدا و امن نگه دارید؛ dump بدون `MASTER_KEY` نمی‌تواند credentialهای provider را رمزگشایی کند.
- `pg-restore-verify.sh` checksum را می‌سنجد، dump را در یک دیتابیس موقت بازیابی می‌کند، تاریخچهٔ migration و خوانا بودن جدول‌های اصلی را بررسی و تعداد ردیف‌ها را چاپ می‌کند و دیتابیس موقت را حذف می‌کند. به دیتابیس اصلی هرگز دست نمی‌زند: دیتابیس موقت در هر اجرا نام یکتای تازه می‌گیرد (`dirouter_restore_check_<time>_<pid>`)، اگر این نام با نام دیتابیس اصلی برابر باشد یا از قبل وجود داشته باشد اسکریپت اجرا نمی‌شود، جز دیتابیسی که خودش ساخته چیزی را حذف نمی‌کند و همان را هم در صورت شکست یا قطع شدن اجرا حذف می‌کند (`KEEP=1` آن را نگه می‌دارد).
- **این تمرین بی‌هزینه نیست.** به سروری نیاز دارد که نوشتن بپذیرد؛ پس به‌طور پیش‌فرض روی primary اجرا می‌شود: آنجا CPU و دیسک مصرف می‌کند و با overlay مربوط به HA هر ردیف بازیابی‌شده به standby هم stream و در آرشیو WAL هم نوشته می‌شود. آن را خارج از ساعت اوج اجرا کنید و حدوداً به اندازهٔ حجم دیتابیس WAL اضافه انتظار داشته باشید. برای اینکه اصلاً روی سرورهای production اجرا نشود، `COMPOSE` و `PG_SERVICE` را به یک PostgreSQL جدا بدهید (مثلاً یک پروژهٔ Compose دیگر روی میزبانی دیگر).

### آرشیو WAL و base backup

overlay مربوط به HA آرشیو پیوسته را روی primary روشن می‌کند (و روی standby، که بعد از ارتقا فعال می‌شود):

- `archive_mode=on`؛ `archive_command` اسکریپت `deploy/ha/postgres/archive-wal.sh` را اجرا می‌کند که هر فایل WAL کامل‌شده را فشرده در volume با نام `pgwal-archive` ذخیره می‌کند. با نام موقت می‌نویسد و هرگز فایل آرشیوشده را با محتوای متفاوت بازنویسی نمی‌کند.
- `archive_timeout=300`: هر تغییر حداکثر پنج دقیقه بعد به آرشیو می‌رسد (standby معمولاً در کمتر از یک ثانیه آن را دارد).
- `pg-basebackup.sh` یک بکاپ فیزیکی در volume با نام `pgbasebackup` می‌نویسد، دو تای آخر را نگه می‌دارد (`BASEBACKUP_KEEP`) و WAL آرشیوشدهٔ قدیمی‌تر از قدیمی‌ترین بکاپ نگه‌داشته‌شده را حذف می‌کند. **تا وقتی اولین base backup وجود ندارد آرشیو فقط بزرگ می‌شود و قابل استفاده نیست**؛ پس بلافاصله بعد از اولین راه‌اندازی یکی بگیرید و بعد طبق زمان‌بندی ادامه دهید.

archiver را زیر نظر داشته باشید؛ تا وقتی آرشیو شکست می‌خورد PostgreSQL فایل‌های WAL را در `pg_wal` نگه می‌دارد و volume داده پر می‌شود:

```bash
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -xc 'SELECT archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_wal, last_failed_time FROM pg_stat_archiver'
```

**کپی به S3 یا MinIO.** هر دو volume روی همان میزبان دیتابیس هستند و با از دست رفتن میزبان از بین می‌روند. سرویس اختیاری `backup-sync` هر دقیقه آرشیو و base backupها را به هر bucket سازگار با S3 کپی می‌کند:

```bash
# .env
BACKUP_S3_ENDPOINT=https://minio.example.com
BACKUP_S3_BUCKET=dirouter-backups
BACKUP_S3_ACCESS_KEY=...
BACKUP_S3_SECRET_KEY=...

$C --profile backup-s3 up -d backup-sync
$C --profile backup-s3 logs -f backup-sync
```

این سرویس `wal/` و `basebackup/` را در bucket می‌نویسد و هرگز چیزی را آنجا حذف نمی‌کند؛ برای نگهداری از lifecycle rule خود bucket استفاده کنید و به کلید فقط دسترسی نوشتن روی همین bucket بدهید. اگر ترجیح می‌دهید PostgreSQL خودش هر فایل را آپلود کند، یک image با کلاینت S3 بسازید و کپی داخل `archive-wal.sh` را عوض کنید (مثلاً `aws s3 cp "$1" "s3://bucket/wal/$2"` یا `mc cp`)؛ اسکریپت همچنان باید هر وقت فایل امن ذخیره نشده با کد غیرصفر خارج شود. dumpهای روزانهٔ `pg-backup.sh` را هم با همان ابزار از cron آپلود کنید.

### بازیابی نقطه‌ای (PITR)

وقتی خود داده خراب شده (migration اشتباه، حذف گسترده) و وضعیت درست پیش از یک لحظهٔ مشخص را می‌خواهید از آن استفاده کنید. این کار پوشهٔ دادهٔ primary را جایگزین می‌کند؛ با آرامش انجام دهید و اول روی میزبانی غیر از production تمرین کنید.

1. هر چیزی را که از دیتابیس استفاده می‌کند متوقف کنید (ترافیک LLM از گیت‌وی ادامه دارد):
   ```bash
   $C stop control-api worker postgres-standby postgres
   ```
2. جدیدترین base backupی را انتخاب کنید که **پیش از** زمان هدف گرفته شده است. اگر میزبان از دست رفته، اول `wal/` و `basebackup/` را از bucket به دو volume برگردانید.
   ```bash
   $C run --rm --no-deps --entrypoint sh postgres -c 'ls /var/lib/postgresql/basebackup'
   ```
3. یک کپی از پوشهٔ دادهٔ فعلی نگه دارید (اگر زمان هدف اشتباه بود تنها راه برگشت است)، بعد آن را با base backup جایگزین کنید و بازیابی تا زمان هدف را بخواهید. `restore_command` را overlay از قبل تنظیم کرده است.
   ```bash
   $C run --rm --no-deps -u postgres --entrypoint sh \
     -e BACKUP=dirouter-20261201T030000Z -e TARGET='2026-12-01 14:25:00+00' postgres -ec '
       cd /var/lib/postgresql
       tar -czf "basebackup/before-pitr-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C data .
       find data -mindepth 1 -delete
       tar -xzf "basebackup/$BACKUP/base.tar.gz" -C data
       tar -xzf "basebackup/$BACKUP/pg_wal.tar.gz" -C data/pg_wal
       touch data/recovery.signal
       printf "%s\n" "recovery_target_time = '"'"'$TARGET'"'"'" "recovery_target_action = '"'"'promote'"'"'" >> data/postgresql.auto.conf
     '
   ```
4. فقط primary را راه بیندازید و replay را تا پذیرفتن اتصال دنبال کنید:
   ```bash
   $C up -d --no-deps postgres
   $C logs -f postgres          # "recovery stopping before commit ..." و بعد "database system is ready to accept connections"
   $C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT pg_is_in_recovery()'   # f
   $C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'ALTER SYSTEM RESET recovery_target_time' -c 'ALTER SYSTEM RESET recovery_target_action'
   ```
   اگر log بگوید زمان هدف پیش از پایان بکاپ است، base backup قدیمی‌تری انتخاب کنید.
5. داده را بررسی کنید و بعد برنامه‌ها را راه بیندازید: `$C up -d --no-deps control-api worker`.
6. primary بازیابی‌شده روی timeline جدید است و standby قدیمی نمی‌تواند آن را دنبال کند. دوباره clone بگیرید (دستورها در بخش «standby و replication slot آن»)، یک base backup تازه بگیرید (`./scripts/backup/pg-basebackup.sh`) و وقتی مطمئن شدید کپی `before-pitr-*.tar.gz` را حذف کنید.

زمان replay به مقدار WAL بین base backup و زمان هدف بستگی دارد؛ این هم دلیل دیگری برای گرفتن منظم base backup است. مدت هر تمرین را در جدول ثبت پایین بنویسید.

## ثبت تمرین‌ها

همهٔ ردیف‌های 2026-11-20 روی یک میزبان Docker ثبت شده‌اند (macOS Docker Desktop، ۴ CPU و ۴ گیگابایت حافظه، working tree اسپرینت ۲) و لایهٔ دادهٔ overlay به‌صورت یک پروژهٔ Compose جدا اجرا می‌شد. سناریوی replica گیت‌وی، لایهٔ برنامه، سرویس جانبی `backup-s3` و بازیابی نقطه‌ای هنوز ردیفی ندارند، چون هنوز آزموده نشده‌اند.

**ثبت تمرین ماهانه** (بعد از هر تمرین یک ردیف اضافه شود):

| تاریخ      | فایل dump                                       | زمان بازیابی | migrationهای اعمال‌شده | نتیجه                                             | مسئول       | یادداشت                                                                                                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------- | ------------ | ---------------------- | ------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-20 | `dirouter-20261120T192907Z.dump` (۹۷۲٬۵۹۲ بایت) | ۱ ثانیه      | ۶                      | بررسی‌ها قبول؛ دیتابیس موقت حذف شد (۰ باقی‌مانده) | maintainers | dump با `pg-backup.sh` از دیتابیس توسعه گرفته و checksum آن تأیید شد؛ با `pg-restore-verify.sh` در یک دیتابیس موقت روی primary مربوط به HA بازیابی شد. تعداد ردیف‌ها: ۳ سازمان، ۱۲ کاربر، ۱۶ provider، ۱۶ credential، ۱۸ مدل، ۶۶ کلید API، ۱۲٬۰۴۲ ردیف دفتر مصرف، ۵۰ نسخهٔ config و ۳۳۰ ردیف ممیزی؛ آخرین نسخهٔ config برابر ۱۸۴. |

**ثبت تمرین failover:**

| تاریخ      | سناریو                                                                                                                                             | زمان بازیابی                                                                     | درخواست‌های ناموفق                 | یادداشت                                                                                                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-20 | توقف primary در Valkey                                                                                                                             | ۷ ثانیه تا ارتقای یک replica توسط sentinelها                                     | — (بدون بار کلاینت)                | کلیدی که پیش از failover نوشته شده بود روی primary جدید وجود داشت. sentinelی که ری‌استارت شد primary جدید را نگه داشت. primary قبلی به‌عنوان replica برگشت (link برقرار) و داده‌ای را که بعد از failover نوشته شده بود گرفت.                                                                                                                    |
| 2026-11-20 | توقف primary در Valkey، با کلاینت برنامه                                                                                                           | —                                                                                | ۰ از ۲۸۲ نوشتن                     | کلاینت Sentinel خود سرویس‌ها (`connectValkey` با URL از نوع `redis+sentinel://`) در طول failover به مدت ۴۰ ثانیه هر ۱۰۰ میلی‌ثانیه یک بار نوشت؛ primary از `.11` به `.12` تغییر کرد.                                                                                                                                                            |
| 2026-11-20 | توقف primary در PostgreSQL (runbook)                                                                                                               | ۲ ثانیه برای گام‌های ۱ تا ۳                                                      | — (برنامه‌ها وصل نبودند)           | تأخیر replay در standby هنگام بررسی ۲٫۷ ثانیه بود (دیتابیس بی‌کار). `pg_promote()` مقدار true و `pg_is_in_recovery()` مقدار false برگرداند؛ ردیفی که پیش از قطعی نوشته شده بود وجود داشت و نوشتن جدید پذیرفته شد. آرشیو WAL روی گرهٔ ارتقایافته فعال بود (۳ segment آرشیوشده، ۰ ناموفق). گام‌های ۴ و ۵ (وصل کردن برنامه‌ها) جزو این تمرین نبود. |
| 2026-11-20 | بررسی streaming replication                                                                                                                        | —                                                                                | —                                  | وضعیت `streaming` در `pg_stat_replication`، slot با نام `dirouter_standby` فعال، standby فقط‌خواندنی و در حال دریافت ردیف‌ها.                                                                                                                                                                                                                   |
| 2026-11-20 | base backup و آرشیو WAL                                                                                                                            | —                                                                                | —                                  | `pg-basebackup.sh` یک base backup نوشت؛ `pg_stat_archiver` مقدار ۷ آرشیوشده و ۰ ناموفق نشان داد.                                                                                                                                                                                                                                                |
| 2026-11-21 | کل overlay با ایمیج‌های production: ۳ گیت‌وی، ۲ control-api و ۲ worker (بدون Traefik؛ هر replica مستقیم با `scripts/verify/ha-app.mjs` صدا زده شد) | تغییر config پس از ۱۷۵ میلی‌ثانیه و rollback پس از ۷۵ میلی‌ثانیه روی هر ۳ گیت‌وی | ۰                                  | هر replica درخواست‌ها را پاسخ داد و شناسهٔ instance خودش را گزارش کرد. کلیدی با سقف ۶ درخواست در دقیقه، از ۱۸ درخواست پخش‌شده روی سه replica دقیقاً ۶ پاسخ موفق گرفت (یک شمارندهٔ مشترک از طریق Sentinel).                                                                                                                                      |
| 2026-11-21 | توقف primary در Valkey زیر بار روی کل overlay (حدود ۳۸ درخواست در ثانیه روی ۳ گیت‌وی، ۴۰ ثانیه)                                                    | sentinelها primary را به `.12` منتقل کردند                                       | ۰ از ۱٬۵۲۲                         | p95 برابر ۱۳ میلی‌ثانیه.                                                                                                                                                                                                                                                                                                                        |
| 2026-11-21 | توقف primary در PostgreSQL زیر بار روی کل overlay (۳۰ ثانیه)                                                                                       | —                                                                                | ۰ از ۱٬۱۲۸                         | گیت‌وی‌ها در مسیر درخواست از PostgreSQL استفاده نمی‌کنند؛ p95 برابر ۱۱ میلی‌ثانیه.                                                                                                                                                                                                                                                              |
| 2026-11-21 | kill شدن یکی از سه replica گیت‌وی زیر بار (۳۰ ثانیه)                                                                                               | —                                                                                | ۰ از ۷۴۸ روی دو replica باقی‌مانده | درخواست‌هایی که مستقیم به replica متوقف‌شده فرستاده شدند شکست خوردند که بدون load balancer طبیعی است. سهم درخواست‌های ازدست‌رفته پشت Traefik (health check و retry) اندازه‌گیری نشده است. کانتینری که با `docker kill` متوقف شود با restart policy برنمی‌گردد؛ با `up -d` دوباره بالا بیاوریدش.                                                 |

تست chaos ([benchmarks/chaos.fa.md](benchmarks/chaos.fa.md)) می‌تواند عددهای ردیف‌های Valkey و گیت‌وی را پشت Traefik تولید کند؛ سناریوی `gateway-replica` آن روی stack توسعه با دو replica اندازه‌گیری شده (۰٫۳۲٪ ناموفق)، ولی هنوز روی این overlay نه. اسکریپت `scripts/verify/ha-app.mjs` ردیف‌های لایهٔ برنامه در جدول بالا را تکرار می‌کند (روش اجرا در سرآغاز خود اسکریپت آمده است).

</div>
