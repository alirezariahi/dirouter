[English](#english) · [فارسی](#persian)

<a id="english"></a>

# ADR-0003: Valkey for counters, cache and pub/sub

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** DiRouter team

## Context

Several gateway replicas must share a common view of: rate limit counters (RPM, TPM, concurrency), real-time budget consumption, circuit breaker state, key cooldowns and model lockouts. Config changes must also reach all gateways quickly. These operations must be atomic and complete in under one millisecond; Postgres is not suitable for this.

### Decision Drivers

- atomic multi-step operations (Lua script) for a sliding window or GCRA
- latency below 1ms
- pub/sub for announcing config changes
- an open license and no risk of a license change
- compatibility with existing libraries (ioredis, BullMQ)

### Considered Options

1. Valkey
2. Redis 8
3. an in-memory counter in each gateway with a divided quota
4. NATS JetStream KV

## Decision

**Valkey** (a BSD-licensed fork of Redis, compatible with the RESP protocol) with the `ioredis` client.

- rate limits and budgets with an atomic Lua script; keys with TTL.
- the pub/sub channel `config:changed` announces a new snapshot version.
- breaker and cooldown state with TTL, for sharing between replicas.
- **local fallback:** if Valkey is unavailable, an in-memory limiter with the quota divided between nodes works, and the behavior is set by `failMode` (`open` or `closed`).

## Consequences

### Positive

- one component for counters, cache, pub/sub and the queue (ADR-005).
- BSD license; compatible with all Redis tools.
- a clear HA path: Sentinel or Cluster (card 17.3).

### Negative

- a runtime dependency for the gateway; the local fallback is less accurate (it may slightly exceed the allowed limit).
- data lives in memory; the budget counter must be periodically reconciled with the ledger in Postgres.

### Follow-up

- card 6.1 (distributed rate limiter) and card 6.3 (budget) specify the algorithm details.

---

<a id="persian"></a>

# ADR-0003: Valkey برای شمارنده، کش و pub/sub

- **وضعیت:** پذیرفته‌شده
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه (Context)

چند replica از گیت‌وی باید یک دید مشترک از این‌ها داشته باشند: شمارندهٔ rate limit (RPM، TPM، هم‌زمانی)، مصرف لحظه‌ای بودجه، وضعیت circuit breaker، cooldown کلیدها و lockout مدل‌ها. تغییر config هم باید سریع به همهٔ گیت‌وی‌ها برسد. این عملیات باید زیر یک میلی‌ثانیه و اتمیک باشند؛ Postgres برای این کار مناسب نیست.

### معیارهای تصمیم (Decision Drivers)

- عملیات اتمیک چندمرحله‌ای (Lua script) برای sliding window یا GCRA
- latency زیر ۱ms
- pub/sub برای انتشار تغییر config
- لایسنس باز و بدون ریسک تغییر لایسنس
- سازگاری با کتابخانه‌های موجود (ioredis، BullMQ)

### گزینه‌های بررسی‌شده (Considered Options)

1. Valkey
2. Redis 8
3. شمارندهٔ داخل حافظهٔ هر گیت‌وی با سهمیهٔ تقسیم‌شده
4. NATS JetStream KV

## تصمیم (Decision)

**Valkey** (فورک BSD-licensed Redis، سازگار با پروتکل RESP) با کلاینت `ioredis`.

- rate limit و بودجه با Lua script اتمیک؛ کلیدها با TTL.
- pub/sub کانال `config:changed` برای اعلام نسخهٔ جدید snapshot.
- وضعیت breaker و cooldown با TTL برای اشتراک بین replicaها.
- **fallback محلی:** اگر Valkey در دسترس نباشد، limiter داخل حافظه با سهمیهٔ تقسیم‌شده بین نودها کار می‌کند و رفتار با `failMode` (`open` یا `closed`) تعیین می‌شود.

## پیامدها (Consequences)

### مثبت

- یک جزء برای شمارنده، کش، pub/sub و صف (ADR-005).
- لایسنس BSD؛ سازگار با همهٔ ابزارهای Redis.
- مسیر HA روشن: Sentinel یا Cluster (کارت ۱۷.۳).

### منفی

- یک وابستگی زمان اجرا برای گیت‌وی؛ fallback محلی دقت کمتری دارد (ممکن است کمی بیش از سقف مجاز شود).
- داده‌ها در حافظه‌اند؛ شمارندهٔ بودجه باید به‌صورت دوره‌ای با ledger در Postgres تطبیق داده شود.

### پیگیری

- کارت ۶.۱ (rate limiter توزیع‌شده) و ۶.۳ (بودجه) جزئیات الگوریتم را مشخص می‌کنند.
