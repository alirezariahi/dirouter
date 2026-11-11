# خط لولهٔ رویداد مصرف و worker

کد: `apps/gateway/src/usage-sink.ts`، `apps/worker/src/*` · کارت‌های ۶.۴، ۶.۵ و ۳.۲

```
گیت‌وی ──emit (همگام، بدون I/O)──▶ بافر حافظه ──هر ۲۵۰ms یا ۵۰۰ رویداد──▶ BullMQ «usage» روی Valkey
   │                                     │
   │                          Valkey قطع؟ ▼
   │                         outbox محلی: <DATA_DIR>/outbox/usage-*.ndjson (append-only)
   │                                     │ پس از برگشت Valkey، replay به ترتیب
   ▼
worker ──دسته‌ای (createMany + skipDuplicates)──▶ request_log + usage_ledger (یک تراکنش)
   │                                              │
   └── ساعت‌های تغییرکرده ──▶ Valkey set ──rollup (۳۰s)──▶ usage_hourly ──▶ usage_daily
```

## تضمین‌ها

| خواسته                               | چطور                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| مسیر درخواست منتظر DB یا Valkey نیست | `emit` فقط به آرایه اضافه می‌کند. ارسال در پس‌زمینه و سریالی است. اتصال Valkey در گیت‌وی `enableOfflineQueue: false` دارد، پس در قطعی فرمان فوراً شکست می‌خورد و نه معلق می‌ماند.                                                                                                       |
| هیچ رکوردی گم نشود                   | دستهٔ ناموفق به فایل outbox اضافه می‌شود. تا وقتی outbox خالی نشده، رویدادهای تازه هم به outbox می‌روند تا ترتیب حفظ شود. در shutdown، بعد از drain، `sink.close()` بافر را می‌فرستد یا در outbox می‌نویسد. outbox باقی‌مانده از اجرای قبلی در شروع replay می‌شود.                      |
| رکورد تکراری ساخته نشود              | jobId در BullMQ همان `idempotencyKey` (request id) است، پس تکراری در صف یکی می‌شود. در DB، PK `request_log` برابر `(id, created_at)` و `usage_ledger.request_id` unique است و درج با `ON CONFLICT DO NOTHING` انجام می‌شود.                                                             |
| replicaها با volume مشترک            | هر فایل outbox قبل از replay با `rename` اتمیک به `….replaying-<host>-<pid>` claim می‌شود: فقط یک replica موفق می‌شود و append بعدیِ نویسنده فایل تازه می‌سازد. فایل replica دیگر بعد از ۱ ثانیه مکث خوانده می‌شود. claimهای کهنه‌تر از ۶۰ ثانیه (replica مرده) دوباره برداشته می‌شوند. |
| رویداد خراب بقیه را نگه ندارد        | اگر دسته شکست بخورد (مثلاً FK سازمان حذف‌شده)، رویدادها تک‌تک نوشته می‌شوند. فقط رویداد خراب retry می‌شود.                                                                                                                                                                              |
| retry و dead-letter                  | هر job ۸ تلاش با backoff نمایی دارد (از ۱ ثانیه، حدود ۴ دقیقه در کل). بعد از آخرین تلاش، یا برای رویداد نامعتبر (`UnrecoverableError`)، job به صف `usage-dead` می‌رود و برای بررسی دستی نگه داشته می‌شود.                                                                               |

## worker

| کار          | زمان‌بندی                          | توضیح                                                                                                                  |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| مصرف `usage` | پیوسته، concurrency ۲۰۰            | دسته‌های ۵۰۰تایی یا هر ۲۰۰ms (`USAGE_BATCH_SIZE`، `USAGE_FLUSH_MS`). promise هر job بعد از commit دسته resolve می‌شود. |
| `rollup`     | هر ۳۰ ثانیه (`ROLLUP_INTERVAL_MS`) | ساعت‌های علامت‌خورده با `SPOP` اتمیک، به‌علاوهٔ ساعت جاری و قبلی، و بعد روزهایشان                                      |
| `partitions` | هر ساعت                            | ماه جاری و ۳ ماه بعد (advisory lock)                                                                                   |
| `retention`  | هر روز 03:17 UTC                   | حذف پارتیشن‌های قدیمی‌تر از `REQUEST_LOG_RETENTION_MONTHS` (پیش‌فرض ۳)                                                 |

- **چند replica**: زمان‌بندی با job scheduler در BullMQ است و هر tick فقط یک job می‌سازد که فقط یک replica آن را برمی‌دارد. `upsertJobScheduler` در هر replica بی‌خطر است. jobهای usage هم هر کدام فقط به یک worker می‌رسند.
- **endpointها** (پورت 3100، فقط شبکهٔ internal): `/healthz`، `/readyz` (Postgres و Valkey) و `/metrics`.
- **shutdown**: jobهای فعال تمام می‌شوند و بافر writer نوشته می‌شود؛ بعد اتصال‌ها بسته می‌شوند (`stop_grace_period: 30s`).

> ADR-001 برای worker «NestJS standalone» گفته بود. worker فعلی TypeScript ساده است، چون هیچ HTTP API یا DI پیچیده‌ای ندارد و BullMQ کل چرخهٔ job را مدیریت می‌کند. اگر بعداً ماژول مشترک با control-api لازم شد، با `NestFactory.createApplicationContext` قابل افزودن است.

## متریک‌ها

| متریک                                               | نوع                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `dirouter_queue_jobs{queue,state}`                  | gauge: waiting، active، delayed، failed و completed برای `usage`، `usage-dead` و `maintenance` |
| `dirouter_usage_events_written_total`               | counter                                                                                        |
| `dirouter_usage_events_failed_total`                | counter (تلاش ناموفق)                                                                          |
| `dirouter_usage_events_dead_total`                  | counter (رفته به dead-letter)                                                                  |
| `dirouter_worker_job_duration_seconds{job,outcome}` | histogram برای usage و maintenance                                                             |
| `dirouter_worker_*`                                 | متریک‌های پیش‌فرض Node (CPU، heap، event loop)                                                 |

## تست‌ها

- واحد: `apps/gateway/src/usage-sink.test.ts` (outbox، replay به ترتیب، replay نیمه‌کاره، دو replica روی یک volume) و `apps/worker/src/writer.test.ts` (دسته، تکراری، جداسازی رویداد خراب).
- یکپارچه روی Postgres و Valkey واقعی: `apps/worker/src/pipeline.integration.test.ts` (رویداد تکراری، rollup دقیق و idempotent، ساخت و حذف پارتیشن)، در job integration در CI.

## بررسی در compose (۲۰۲۶-۱۱-۰۷)

| سناریو                                                                    | نتیجه                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **قطع ۵ دقیقه‌ای Valkey** (`docker compose stop valkey`) با ترافیک پیوسته | گیت‌وی در تمام مدت ۵۹۹ پاسخ 200 داد، بدون حتی یک خطا. ۵۵۹ رویداد در یک فایل outbox نوشته شد. بعد از `start valkey`: request_log ۵۹۹ ردیف، ledger ۵۹۹، شناسهٔ یکتا ۵۹۹، و outbox خالی. **هیچ رکوردی گم یا تکراری نشد.** |
| ۱۰۰ درخواست هم‌زمان و دو combo                                            | ۱۰۲ ردیف. attempts کامل در request_log (combo `gpt-4.1`: سه تلاش، دو خطای 503 روی `mock-down` و موفقیت روی `mock`)                                                                                                     |
| rollup                                                                    | `usage_hourly` و `usage_daily` با تعداد، خطا، هزینه و هیستوگرام درست                                                                                                                                                   |
| **دو replica از worker** (`--scale worker=2`)                             | ۳۰۰ درخواست به ۳۰۰ ردیف یکتا رسید. هر tick سی‌ثانیه‌ای rollup دقیقاً یک بار اجرا شد، یک بار در worker-1 و یک بار در worker-2، بدون tick تکراری.                                                                        |
| retry و dead-letter                                                       | رویداد نامعتبر بعد از ۱ تلاش به `usage-dead` رفت. رویداد با سازمان ناموجود (FK) بعد از ۳ تلاش به `usage-dead` رفت و هیچ ردیف نیمه‌کاره‌ای در request_log نماند.                                                        |
| `/metrics`                                                                | `dirouter_queue_jobs{queue="usage",state="completed"} 1001` و بقیهٔ متریک‌ها. scrape توسط Prometheus در پروفایل monitoring است (کارت ۸.۳).                                                                             |
