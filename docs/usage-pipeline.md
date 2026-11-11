[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Usage event pipeline and worker

Code: `apps/gateway/src/usage-sink.ts`, `apps/worker/src/*` · Cards 6.4, 6.5 and 3.2

```
gateway ──emit (synchronous, no I/O)──▶ memory buffer ──every 250ms or 500 events──▶ BullMQ "usage" on Valkey
   │                                     │
   │                          Valkey down? ▼
   │                         local outbox: <DATA_DIR>/outbox/usage-*.ndjson (append-only)
   │                                     │ after Valkey returns, replayed in order
   ▼
worker ──batched (createMany + skipDuplicates)──▶ request_log + usage_ledger (one transaction)
   │                                              │
   └── changed hours ──▶ Valkey set ──rollup (30s)──▶ usage_hourly ──▶ usage_daily
```

## Guarantees

| Requirement                                     | How                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The request path does not wait for DB or Valkey | `emit` only appends to an array. Sending happens in the background and serially. The Valkey connection in the gateway has `enableOfflineQueue: false`, so during an outage commands fail immediately instead of hanging.                                                                                    |
| No record is lost                               | A failed batch is appended to the outbox file. Until the outbox is empty, new events also go to the outbox to keep the order. At shutdown, after drain, `sink.close()` sends the buffer or writes it to the outbox. An outbox left over from a previous run is replayed at startup.                         |
| No duplicate record is created                  | The jobId in BullMQ is the same as the `idempotencyKey` (request id), so a duplicate in the queue is merged into one. In the DB, the PK of `request_log` is `(id, created_at)` and `usage_ledger.request_id` is unique, and inserts are done with `ON CONFLICT DO NOTHING`.                                 |
| Replicas with a shared volume                   | Before replay, each outbox file is claimed by an atomic `rename` to `….replaying-<host>-<pid>`: only one replica succeeds, and the writer's next append creates a new file. The other replica's file is read again after a one-second pause. Claims older than 60 seconds (a dead replica) are taken again. |
| A bad event does not hold back the rest         | If a batch fails (for example an FK to a deleted organization), the events are written one by one. Only the bad event is retried.                                                                                                                                                                           |
| Retry and dead-letter                           | Each job has 8 attempts with exponential backoff (starting at 1 second, about 4 minutes in total). After the last attempt, or for an invalid event (`UnrecoverableError`), the job goes to the `usage-dead` queue and is kept for manual review.                                                            |

## Worker

| Job          | Schedule                                | Description                                                                                                               |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `usage`      | continuous, concurrency 200             | Batches of 500 or every 200ms (`USAGE_BATCH_SIZE`, `USAGE_FLUSH_MS`). Each job's promise resolves after the batch commit. |
| `rollup`     | every 30 seconds (`ROLLUP_INTERVAL_MS`) | Flagged hours via an atomic `SPOP`, plus the current and previous hour, and then their days                               |
| `partitions` | hourly                                  | The current month and the 3 following months (advisory lock)                                                              |
| `retention`  | daily at 03:17 UTC                      | Deletes partitions older than `REQUEST_LOG_RETENTION_MONTHS` (default 3)                                                  |

- **Multiple replicas**: scheduling uses the BullMQ job scheduler, and each tick creates only one job, which only one replica takes. `upsertJobScheduler` is safe in every replica. Usage jobs also each reach only one worker.
- **Endpoints** (port 3100, internal network only): `/healthz`, `/readyz` (Postgres and Valkey) and `/metrics`.
- **Shutdown**: active jobs finish and the writer's buffer is written; then the connections are closed (`stop_grace_period: 30s`).

> ADR-001 said the worker should be "NestJS standalone". The current worker is plain TypeScript, because it has no HTTP API or complex DI, and BullMQ manages the whole job lifecycle. If a shared module with control-api is needed later, it can be added with `NestFactory.createApplicationContext`.

## Metrics

| Metric                                              | Type                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `dirouter_queue_jobs{queue,state}`                  | gauge: waiting, active, delayed, failed and completed for `usage`, `usage-dead` and `maintenance` |
| `dirouter_usage_events_written_total`               | counter                                                                                           |
| `dirouter_usage_events_failed_total`                | counter (failed attempt)                                                                          |
| `dirouter_usage_events_dead_total`                  | counter (moved to dead-letter)                                                                    |
| `dirouter_worker_job_duration_seconds{job,outcome}` | histogram for usage and maintenance                                                               |
| `dirouter_worker_*`                                 | default Node metrics (CPU, heap, event loop)                                                      |

## Tests

- Unit: `apps/gateway/src/usage-sink.test.ts` (outbox, ordered replay, half-finished replay, two replicas on one volume) and `apps/worker/src/writer.test.ts` (batch, duplicates, isolation of a bad event).
- Integration on real Postgres and Valkey: `apps/worker/src/pipeline.integration.test.ts` (duplicate event, exact and idempotent rollup, creating and deleting partitions), in the integration job in CI.

## Compose check (2026-11-07)

| Scenario                                                                           | Result                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5-minute Valkey outage** (`docker compose stop valkey`) under continuous traffic | The gateway returned 200 for the whole time: 599 responses, with not even one error. 559 events were written to one outbox file. After `start valkey`: request_log had 599 rows, the ledger 599, unique ids 599, and the outbox was empty. **No record was lost or duplicated.** |
| 100 concurrent requests and two combos                                             | 102 rows. Complete attempts in request_log (combo `gpt-4.1`: three attempts, two 503 errors on `mock-down` and success on `mock`)                                                                                                                                                |
| rollup                                                                             | `usage_hourly` and `usage_daily` correct, with counts, errors, cost and the histogram                                                                                                                                                                                            |
| **Two worker replicas** (`--scale worker=2`)                                       | 300 requests reached 300 unique rows. Each thirty-second rollup tick ran exactly once, once in worker-1 and once in worker-2, with no duplicate tick.                                                                                                                            |
| retry and dead-letter                                                              | An invalid event went to `usage-dead` after 1 attempt. An event with a missing organization (FK) went to `usage-dead` after 3 attempts, and no half-written row remained in request_log.                                                                                         |
| `/metrics`                                                                         | `dirouter_queue_jobs{queue="usage",state="completed"} 1001` and the other metrics. Prometheus scrapes it in the monitoring profile (card 8.3).                                                                                                                                   |

---

<a id="persian"></a>

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
