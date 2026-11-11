[English](#english) · [فارسی](#persian)

<a id="english"></a>

# ADR-0006: Data-plane independence from the control plane

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decision makers:** DiRouter team

## Context

Gateway is the critical path for customer traffic. The control plane (control-api, worker, PostgreSQL, and dashboard) changes and deploys more frequently and has more opportunities for failure. If every request needs control-api or PostgreSQL, a control-plane outage or migration becomes a traffic outage.

### Decision drivers

- A target availability of 99.95% for LLM traffic.
- Control-plane deployment and migration without interrupting traffic.
- Low latency, with no database queries on the hot path.

### Considered options

1. Gateway reads configuration from the database, with caching.
2. Gateway calls control-api for each request.
3. Gateway retains a complete, versioned configuration snapshot in memory and on disk.

## Decision

Choose option 3: **gateway operates from snapshots**.

- After configuration changes, control-api publishes a complete `ConfigSnapshot` with monotonic `version` and `schemaVersion`; the schema lives in `@dirouter/contracts`.
- Gateway keeps the snapshot in memory, persists it to disk, and receives changes through Valkey pub/sub or long polling.
- When control-api is unavailable, gateway continues using the last valid snapshot and can bootstrap from its on-disk copy.
- Gateway has no code dependency on `@dirouter/db` and opens no database connection.
- Accounting is asynchronous (ADR-005), and Valkey has a local fallback (ADR-003).

## Consequences

### Positive

- A complete control-plane outage does not interrupt existing configured traffic.
- The hot path avoids database I/O, supporting low and predictable latency.
- Request behavior is reproducible: each request records its `configVersion` in UsageEvent.

### Negative

- Configuration changes take a short time to propagate, typically targeting less than a second, rather than applying instantly.
- Complete snapshots grow with the key population; larger deployments may need incremental snapshots.
- A revoked virtual key can remain usable until the new snapshot arrives. Immediate revocation requires a separate notification such as `key:revoked`.
- Encrypted provider secrets are present on gateway disks. `MASTER_KEY` must be supplied securely to gateway through its environment, not persisted in the snapshot.

### Follow-up

- Implement snapshot generation/publication and gateway synchronization.
- Chaos test: interrupt control-api and PostgreSQL while serving load.

---

<a id="persian"></a>

# ADR-0006: استقلال صفحه داده از صفحه کنترل

- **Status:** Accepted
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه

gateway مسیر بحرانی ترافیک مشتری است. صفحه کنترل (control-api، worker، PostgreSQL و dashboard) بیشتر تغییر و استقرار می‌شود و فرصت‌های بیشتری برای خرابی دارد. اگر هر درخواست به control-api یا PostgreSQL نیاز داشته باشد، قطعی یا مهاجرت صفحه کنترل به قطعی ترافیک تبدیل می‌شود.

### عوامل تصمیم

- دسترس‌پذیری هدف ۹۹٫۹۵٪ برای ترافیک LLM.
- استقرار و مهاجرت صفحه کنترل بدون وقفه در ترافیک.
- تأخیر پایین، بدون پرس‌وجوی پایگاه داده در مسیر پرترافیک.

### گزینه‌های بررسی‌شده

1. gateway پیکربندی را از پایگاه داده با cache بخواند.
2. gateway برای هر درخواست control-api را فراخوانی کند.
3. gateway یک snapshot کامل و نسخه‌دار از پیکربندی را در حافظه و روی دیسک نگه دارد.

## تصمیم

گزینه ۳ انتخاب شد: **gateway با snapshotها کار می‌کند**.

- پس از تغییر پیکربندی، control-api یک `ConfigSnapshot` کامل با `version` یکنواخت و `schemaVersion` منتشر می‌کند؛ schema در `@dirouter/contracts` قرار دارد.
- gateway، snapshot را در حافظه نگه می‌دارد، روی دیسک ذخیره می‌کند و تغییرات را از طریق pub/sub در Valkey یا long polling دریافت می‌کند.
- وقتی control-api در دسترس نیست، gateway به کار با آخرین snapshot معتبر ادامه می‌دهد و می‌تواند از نسخه روی دیسک راه‌اندازی شود.
- gateway هیچ وابستگی کدی به `@dirouter/db` ندارد و اتصال پایگاه داده باز نمی‌کند.
- حسابداری ناهمزمان است (ADR-005) و Valkey یک fallback محلی دارد (ADR-003).

## پیامدها

### مثبت

- قطعی کامل صفحه کنترل، ترافیک موجود و پیکربندی‌شده را قطع نمی‌کند.
- مسیر پرترافیک از I/O پایگاه داده پرهیز می‌کند، که تأخیر کم و قابل‌پیش‌بینی را ممکن می‌سازد.
- رفتار درخواست‌ها قابل بازتولید است: هر درخواست `configVersion` خود را در UsageEvent ثبت می‌کند.

### منفی

- تغییرات پیکربندی زمان می‌برد تا منتشر شوند؛ هدف معمولاً کمتر از یک ثانیه است، نه اعمال آنی.
- snapshotهای کامل با افزایش تعداد کلیدها بزرگ می‌شوند؛ استقرارهای بزرگ‌تر ممکن است به snapshotهای افزایشی نیاز داشته باشند.
- کلید مجازی باطل‌شده تا رسیدن snapshot جدید همچنان قابل استفاده می‌ماند. باطل‌سازی فوری به یک اعلان جدا مانند `key:revoked` نیاز دارد.
- اسرار رمزنگاری‌شدهٔ providerها روی دیسک gateway وجود دارند. `MASTER_KEY` باید به‌صورت امن از طریق متغیرهای محیطی به gateway داده شود و داخل snapshot ذخیره نشود.

### پیگیری

- پیاده‌سازی تولید/انتشار snapshot و همگام‌سازی gateway.
- تست chaos: قطع control-api و PostgreSQL هنگام سرویس‌دهی به بار.
