[English](#english) · [فارسی](#persian)

<a id="english"></a>

# ADR-0006: The data plane does not depend on the control plane

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** DiRouter team

## Context

The gateway is the critical path for customer traffic. The control plane (control-api, worker, Postgres, dashboard) changes more often, is deployed more often and is more likely to fail. If the gateway needed control-api or Postgres for every request, any outage or migration in the control plane would turn into a traffic outage.

### Decision Drivers

- 99.95% availability for LLM traffic
- control plane deploys and migrations with no effect on traffic
- low latency (no database queries on the hot path)

### Considered Options

1. The gateway reads config from the database (with a cache)
2. The gateway asks control-api on every request
3. The gateway keeps a complete, versioned snapshot in memory and on disk

## Decision

Option 3: **the gateway works only with a snapshot.**

- after every change, control-api publishes a complete `ConfigSnapshot` with a monotonic `version` and a `schemaVersion` (the schema is in `@dirouter/contracts`).
- the gateway keeps the snapshot in memory, stores it on disk, and receives changes from Valkey pub/sub or long-poll.
- if control-api is unavailable, the gateway continues with the last healthy snapshot; at boot it starts from the version on disk.
- the gateway has no code dependency on `@dirouter/db` and opens no database connection.
- accounting is asynchronous (ADR-005), and Valkey has a local fallback (ADR-003).

## Consequences

### Positive

- a full control plane outage has no effect on existing traffic.
- the hot path has no database I/O; latency is low and predictable.
- gateway behavior is reproducible: every request is processed with a specific `configVersion` and recorded in the UsageEvent.

### Negative

- config changes are applied with a short delay (usually under one second), not instantly.
- the complete snapshot grows as the number of keys grows; at large scale, an incremental (delta) snapshot is needed.
- revoking a virtual key remains valid until a new valid snapshot arrives; for immediate revocation, a separate pub/sub message (`key:revoked`) is needed.
- provider secrets (encrypted) are on the gateway's disk; `MASTER_KEY` exists only in the gateway's environment.

### Follow-up

- card 3.9 (snapshot build and publish) and card 4.2 (synchronization in the gateway).
- chaos test (card 18.1): stopping control-api and Postgres during load.

---

<a id="persian"></a>

# ADR-0006: data plane به control plane وابسته نیست

- **وضعیت:** پذیرفته‌شده
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه (Context)

گیت‌وی مسیر حیاتی ترافیک مشتری است. control plane (control-api، worker، Postgres، داشبورد) بیشتر تغییر می‌کند، بیشتر deploy می‌شود و احتمال خرابی بیشتری دارد. اگر گیت‌وی برای هر درخواست به control-api یا Postgres نیاز داشته باشد، هر قطعی یا migration در control plane به قطعی ترافیک تبدیل می‌شود.

### معیارهای تصمیم (Decision Drivers)

- دسترس‌پذیری ۹۹٫۹۵٪ برای ترافیک LLM
- deploy و migration control plane بدون اثر روی ترافیک
- latency پایین (بدون query دیتابیس در مسیر داغ)

### گزینه‌های بررسی‌شده (Considered Options)

1. گیت‌وی config را از دیتابیس می‌خواند (با کش)
2. گیت‌وی برای هر درخواست از control-api سؤال می‌کند
3. گیت‌وی یک snapshot کامل و نسخه‌دار در حافظه و دیسک نگه می‌دارد

## تصمیم (Decision)

گزینهٔ ۳: **گیت‌وی فقط با snapshot کار می‌کند.**

- control-api بعد از هر تغییر یک `ConfigSnapshot` کامل با `version` یکنواخت و `schemaVersion` منتشر می‌کند (اسکیما در `@dirouter/contracts`).
- گیت‌وی snapshot را در حافظه نگه می‌دارد، روی دیسک ذخیره می‌کند و تغییرات را از Valkey pub/sub یا long-poll دریافت می‌کند.
- اگر control-api در دسترس نباشد، گیت‌وی با آخرین snapshot سالم ادامه می‌دهد؛ هنگام بوت از نسخهٔ دیسک شروع می‌کند.
- گیت‌وی هیچ وابستگی کدی به `@dirouter/db` ندارد و connection دیتابیس باز نمی‌کند.
- حسابداری غیرهمگام است (ADR-005) و Valkey fallback محلی دارد (ADR-003).

## پیامدها (Consequences)

### مثبت

- قطع کامل control plane روی ترافیک موجود اثری ندارد.
- مسیر داغ بدون I/O دیتابیس؛ latency پایین و قابل پیش‌بینی.
- رفتار گیت‌وی قابل بازتولید است: هر درخواست با یک `configVersion` مشخص پردازش و در UsageEvent ثبت می‌شود.

### منفی

- تغییرات config با تأخیر کوتاه (معمولاً زیر یک ثانیه) اعمال می‌شوند، نه فوری.
- snapshot کامل با رشد تعداد کلیدها بزرگ می‌شود؛ در مقیاس بالا به snapshot افزایشی (delta) نیاز است.
- لغو یک کلید مجازی تا رسیدن snapshot جدید معتبر می‌ماند؛ برای لغو فوری، پیام pub/sub جدا (`key:revoked`) لازم است.
- رازهای provider (رمزشده) روی دیسک گیت‌وی هستند؛ `MASTER_KEY` فقط در env گیت‌وی است.

### پیگیری

- کارت ۳.۹ (ساخت و انتشار snapshot) و ۴.۲ (همگام‌سازی در گیت‌وی).
- تست chaos (کارت ۱۸.۱): قطع control-api و Postgres در حین بار.
