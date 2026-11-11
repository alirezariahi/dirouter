[English](#english) · [فارسی](#persian)

<a id="english"></a>

# ADR-0005: BullMQ for the event queue

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** DiRouter team

## Context

After every request, the gateway produces a `UsageEvent` (cost, tokens, attempt chain). Writing directly to Postgres in the request path raises latency and makes the gateway depend on the database (contrary to ADR-006). Events must reach the worker reliably (at-least-once), and reprocessing must not record a cost twice.

### Decision Drivers

- cheap, asynchronous publishing from the gateway
- at-least-once delivery, retries and a dead-letter queue
- no new infrastructure component in the MVP
- a mature TypeScript library

### Considered Options

1. BullMQ on Valkey
2. Redis Streams with a manual consumer
3. NATS JetStream
4. Kafka / Redpanda

## Decision

**BullMQ** on the same Valkey (ADR-003).

- the `usage-events` queue; the gateway enqueues and does not wait.
- the worker reads events in batches and writes them with `ON CONFLICT (idempotency_key) DO NOTHING`; so a duplicate event is harmless.
- retries with exponential backoff, and a failed queue for manual review.
- **local outbox:** if Valkey is unavailable, the gateway writes events to an append-only file on disk and replays them after reconnecting (card 6.4).
- the worker's scheduled jobs (aggregation, partition creation, maintenance) also use BullMQ repeatable jobs.

## Consequences

### Positive

- no new infrastructure component is added.
- the dashboard can show queue status and failed jobs.
- idempotency is at the database layer, independent of the queue's guarantees.

### Negative

- BullMQ is not optimized for very high throughput (hundreds of thousands of events per second).
- the queue and the counters share one Valkey; queue pressure can affect counter latency. In production, the queue's Valkey can be separated.

### Follow-up

- if event throughput becomes a problem, a new ADR for NATS JetStream or Redpanda.

---

<a id="persian"></a>

# ADR-0005: BullMQ برای صف رویداد

- **وضعیت:** پذیرفته‌شده
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه (Context)

گیت‌وی بعد از هر درخواست یک `UsageEvent` تولید می‌کند (هزینه، توکن، زنجیرهٔ تلاش‌ها). نوشتن مستقیم در Postgres در مسیر درخواست latency را بالا می‌برد و گیت‌وی را به دیتابیس وابسته می‌کند (خلاف ADR-006). رویدادها باید با اطمینان (at-least-once) به worker برسند و پردازش دوباره هزینه را دوبار ثبت نکند.

### معیارهای تصمیم (Decision Drivers)

- انتشار غیرهمگام و ارزان از گیت‌وی
- تحویل at-least-once، retry و dead-letter
- بدون جزء زیرساختی جدید در MVP
- کتابخانهٔ بالغ TypeScript

### گزینه‌های بررسی‌شده (Considered Options)

1. BullMQ روی Valkey
2. Redis Streams با consumer دستی
3. NATS JetStream
4. Kafka / Redpanda

## تصمیم (Decision)

**BullMQ** روی همان Valkey (ADR-003).

- صف `usage-events`؛ گیت‌وی enqueue می‌کند و منتظر نمی‌ماند.
- worker رویدادها را دسته‌ای (batch) می‌خواند و با `ON CONFLICT (idempotency_key) DO NOTHING` می‌نویسد؛ پس تکرار رویداد بی‌ضرر است.
- retry با backoff نمایی و صف شکست‌خورده برای بررسی دستی.
- **outbox محلی:** اگر Valkey در دسترس نباشد، گیت‌وی رویدادها را در یک فایل append-only روی دیسک می‌نویسد و بعد از وصل شدن بازپخش می‌کند (کارت ۶.۴).
- کارهای زمان‌بندی‌شدهٔ worker (تجمیع، ساخت پارتیشن، نگهداری) هم با repeatable jobهای BullMQ.

## پیامدها (Consequences)

### مثبت

- جزء زیرساختی جدیدی اضافه نمی‌شود.
- داشبورد وضعیت صف و کارهای شکست‌خورده در دسترس است.
- idempotency در لایهٔ دیتابیس، مستقل از تضمین‌های صف.

### منفی

- BullMQ برای throughput خیلی بالا (صدها هزار رویداد در ثانیه) بهینه نیست.
- صف و شمارنده‌ها روی یک Valkey‌اند؛ فشار صف می‌تواند روی latency شمارنده‌ها اثر بگذارد. در production می‌توان Valkey صف را جدا کرد.

### پیگیری

- اگر throughput رویداد مشکل شد، ADR جدید برای NATS JetStream یا Redpanda.
