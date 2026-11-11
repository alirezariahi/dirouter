[English](#english) · [فارسی](#persian)

<a id="english"></a>

# ADR-0005: BullMQ for the event queue

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decision makers:** DiRouter team

## Context

Gateway emits a `UsageEvent` after each request, containing cost, tokens, and the attempt chain. Direct PostgreSQL writes add request latency and couple gateway to the database, contrary to ADR-006. Events need reliable at-least-once delivery to worker, while duplicate processing must not create duplicate charges.

### Decision drivers

- Inexpensive asynchronous publication from gateway.
- At-least-once delivery, retries, and failed-job handling.
- No additional infrastructure component in the MVP.
- A mature TypeScript library.

### Considered options

1. BullMQ on Valkey.
2. Redis Streams with a custom consumer.
3. NATS JetStream.
4. Kafka / Redpanda.

## Decision

Use **BullMQ** on the same Valkey instance selected in ADR-003.

- Gateway enqueues onto `usage-events` without waiting for database persistence.
- Worker consumes events in batches. Database uniqueness and `ON CONFLICT ... DO NOTHING` make duplicate events harmless.
- Retry with exponential backoff and retain failed jobs for manual investigation.
- **Local outbox:** when Valkey is unavailable, append events to a local on-disk file and replay after recovery.
- Use repeatable BullMQ jobs for worker aggregation, partition creation, and retention.

## Consequences

### Positive

- No additional infrastructure service is required.
- Queue status and failed jobs can be exposed through a dashboard.
- Database-level idempotency is independent of queue delivery guarantees.

### Negative

- BullMQ is not the intended solution for hundreds of thousands of events per second.
- Counters and queue share Valkey; queue pressure can affect counter latency. Production can separate queue and counter instances.

### Follow-up

- If event throughput becomes a bottleneck, write a new ADR for NATS JetStream or Redpanda.

---

<a id="persian"></a>

# ADR-0005: BullMQ برای صف رویدادها

- **Status:** Accepted
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه

gateway پس از هر درخواست یک `UsageEvent` شامل هزینه، توکن‌ها و زنجیره attemptها ارسال می‌کند. نوشتن مستقیم در PostgreSQL به تأخیر درخواست اضافه می‌کند و gateway را به پایگاه داده وصل می‌کند، که با ADR-006 در تضاد است. رویدادها باید به worker با تحویل قابل‌اتکای at-least-once برسند، در حالی که پردازش تکراری نباید هزینه تکراری ایجاد کند.

### عوامل تصمیم

- انتشار ناهمزمان ارزان از gateway.
- تحویل at-least-once، retry و مدیریت jobهای ناموفق.
- نبود جزء زیرساختی اضافه در MVP.
- یک کتابخانه بالغ TypeScript.

### گزینه‌های بررسی‌شده

1. BullMQ روی Valkey.
2. Redis Streams با consumer سفارشی.
3. NATS JetStream.
4. Kafka / Redpanda.

## تصمیم

از **BullMQ** روی همان نمونه Valkey که در ADR-003 انتخاب شده استفاده شود.

- gateway بدون انتظار برای ماندگاری در پایگاه داده، روی `usage-events` صف‌بندی می‌کند.
- worker رویدادها را به‌صورت دسته‌ای مصرف می‌کند. یکتایی در پایگاه داده و `ON CONFLICT ... DO NOTHING` باعث می‌شوند رویدادهای تکراری بی‌ضرر باشند.
- retry با backoff نمایی انجام می‌شود و jobهای ناموفق برای بررسی دستی نگه داشته می‌شوند.
- **outbox محلی:** وقتی Valkey در دسترس نیست، رویدادها به یک فایل محلی روی دیسک اضافه و پس از بازیابی بازپخش می‌شوند.
- برای تجمیع، ساخت partition و نگهداری داده در worker از jobهای تکرارشونده BullMQ استفاده می‌شود.

## پیامدها

### مثبت

- هیچ سرویس زیرساختی اضافه لازم نیست.
- وضعیت صف و jobهای ناموفق را می‌توان در داشبورد نشان داد.
- idempotency در سطح پایگاه داده مستقل از تضمین‌های تحویل صف است.

### منفی

- BullMQ راه‌حل مناسبی برای صدها هزار رویداد در ثانیه نیست.
- صف و شمارنده‌ها Valkey مشترک دارند؛ فشار صف می‌تواند بر تأخیر شمارنده‌ها اثر بگذارد. در محیط تولید می‌توان نمونه‌های صف و شمارنده را جدا کرد.

### پیگیری

- اگر توان عملیاتی رویدادها به گلوگاه تبدیل شود، یک ADR جدید برای NATS JetStream یا Redpanda نوشته می‌شود.
