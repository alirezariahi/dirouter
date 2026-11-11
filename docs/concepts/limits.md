[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Rate limit and concurrency (cards 5.7 and 6.1)

DiRouter has two layers of limits:

| layer                        | where                          | scope  | purpose                                                                                                                             |
| ---------------------------- | ------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **distributed rate limiter** | Valkey, shared by all replicas | global | RPM, TPM and concurrency for key, project and team                                                                                  |
| **bulkhead**                 | memory of each replica         | local  | protects the node itself: concurrency cap for provider and key with a short queue ([gateway/internals.md](../gateway/internals.md)) |

## Scopes and configuration

| scope       | table / API                                   | fields                          |
| ----------- | --------------------------------------------- | ------------------------------- |
| virtual key | `virtual_keys` (`POST/PATCH /orgs/:org/keys`) | `rpm`, `tpm`, `maxConcurrency`  |
| project     | `rate_limit_policies` with scope=PROJECT      | `rpm`, `tpm`, `max_concurrency` |
| team        | `rate_limit_policies` with scope=TEAM         | same                            |

Each request must be under the limit of **all** its scopes (the key, the key's project, and the project's team). All are checked with one atomic Lua script, and if one rejects, none is consumed. Config comes from the snapshot (card 3.9), and a change reaches the gateway in less than one second.

## Algorithms

The reference clock `TIME` is Valkey's own, so clock differences between nodes have no effect.

- **RPM: exact sliding window** (sliding log)
  - Each accepted request is a member of ZSET `dirouter:rl:rpm:<scope>` with a time score. In any 60-second window at most `rpm` requests are accepted, and a burst at the start of the minute is not compensated later.
  - Memory is O(rpm) per scope.
  - `Retry-After` is exactly the time when the oldest request leaves the window.
- **TPM: reservation and settlement**
  - One-second buckets in HASH `dirouter:rl:tpm:<scope>`.
  - Before the request, an estimate is reserved: input with the fast tokenizer + `min(max_tokens ?? 1024, 8192)`.
  - After the response, the difference from actual usage (input + output) is settled in the same bucket. A failed request returns its estimate.
  - A request larger than the entire cap is accepted only when the window is empty, so it cannot get stuck forever.
- **Concurrency: semaphore with TTL**
  - ZSET `dirouter:rl:conc:<scope>` with an "expiry time" score (default 15 minutes).
  - Removed when the request (or stream) ends. If a node dies, its slot is reclaimed by the TTL.

## Response

A successful response (JSON and stream) carries these headers from the scope with the fewest remaining requests:

```
x-ratelimit-limit-requests: 60
x-ratelimit-remaining-requests: 59
x-ratelimit-reset-requests: 60s
x-ratelimit-limit-tokens: 100000        (if it has tpm)
x-ratelimit-remaining-tokens: 98200
x-ratelimit-reset-tokens: 60s
```

Rejection means 429 with `Retry-After` (seconds) and `x-ratelimit-remaining-requests: 0`:

- OpenAI: `{"error":{"type":"rate_limit_error","code":"rate_limited","message":"Rate limit exceeded for key (requests)"}}`
- Anthropic: `{"type":"error","error":{"type":"rate_limit_error",...}}`

The message says which scope (`key`, `project` or `team`) and which type (`requests`, `tokens` or `concurrency`), but not the IDs.

## Valkey outage

The limiter uses a separate Valkey connection with `enableOfflineQueue: false` and a 100ms timeout per command. Any error or slowness activates degraded mode for 1 second, so each request does not pay a timeout. Behavior is controlled by `settings.failMode`:

| failMode         | behavior during outage                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open` (default) | local limiter in each node's memory with share `ceil(limit / number of live nodes)`. The node count is read every 5 seconds from heartbeats (`dirouter:gateway:node:*`), and the last valid value is kept. |
| `closed`         | requests of scopes that have a cap get 429 "Rate limiter unavailable (fail-closed)"; keys without a cap work normally.                                                                                     |

In no mode does a Valkey outage return a 5xx error. Accuracy in `open` mode is lower: the local limiter has no window history. During an outage minute, up to a full extra cap may be accepted; after Valkey returns, global counting continues.

Without `VALKEY_URL` (single-node run), the local limiter works with its full share.

Status in `GET /internal/health` (with INTERNAL_TOKEN):

```
"rateLimiter": {"remote": …, "local": …, "rejected": …, "degraded": false, "nodes": 3}
```

## Verification (2026-11-08)

- **Tests:**
  - `apps/gateway/src/rate-limiter.test.ts`: 6 local limiter tests and 2 outage tests (Valkey down: local fail-open, fail-closed with 429). With `INTEGRATION_VALKEY_URL`, also 5 tests on a real Valkey:
    - three nodes with a cap of 60 over a compressed 3-second window in 7.5 seconds: 180 ± 5%
    - Retry-After
    - TPM between two nodes
    - global concurrency
    - reclaiming a slot with the TTL
  - `apps/gateway/src/limits.test.ts`: headers in JSON and stream, 429 in both formats, and the shared project cap.
- **Load test:**
  - Setup: three replicas of the production image behind Traefik, with one Valkey, and one key with `rpm: 60` created from control-api
  - Load: 11 concurrent clients over 150 seconds
  - Result: 180 requests accepted (60 / 60 / 60 per minute, zero error rate), 36822 responses of 429, and zero 5xx
  - Distribution across nodes: 61 / 61 / 58
  - 130-second repeat: again 180 accepted, with batches starting at 0.07s, 60.07s and 120.1s
  - With a 0.5-second tolerance for response-time jitter at the window edge, the maximum in any 60-second window was exactly 60.
- **Valkey outage:**
  - `docker pause` on Valkey for 20 seconds, during load
  - zero 5xx; 1175 requests with keys without a cap, all 200
  - each node went once to the local limiter (log "local fallback"), and after Valkey returned, it went back to global mode

# Budget (card 6.3)

A budget is a dollar or token cap for a period:

| scope          | setting                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| key            | `budgets` in `POST/PATCH /orgs/:org/keys` (up to two budgets: daily and monthly) |
| project / team | `budgets` table with scope=PROJECT or TEAM                                       |

Each budget has these fields: `period` (`daily` or `monthly`), `limitUsd` and/or `limitTokens`, and `alertThresholds` (default `[50, 80, 100]`).

## Counter in Valkey

- **Key**: `dirouter:budget:<budgetId>:<periodKey>`, where `periodKey` is `d:2026-11-08` or `m:2026-11` (**UTC**).
- **Automatic reset**: the start of a period means a fresh key. The old key is deleted with a TTL one week after the period ends.
- **Fields**:
  - `usd`: integer in units of 1e-8 dollars, the same precision as the ledger's `Decimal(18,8)`, with no float error
  - `tokens`: input + output
  - `ts`: time of the last increase
- **Before the request**: if the counter of any budget of the key, project or team has reached its cap, the request is rejected. The cost of the request itself is not known before it runs, so a request that has started finishes, and the **next request** is rejected. As a result, spending can exceed the cap by the amount of the last concurrent requests.
- **After the request**: a Lua script atomically increases the counters by the actual cost and tokens (the same `costUsd` as the usage event).

## Response

429 with `Retry-After` until the start of the next period:

- OpenAI: `{"error":{"type":"insufficient_quota","code":"budget_exceeded","message":"Daily key budget exceeded (USD 5)"}}`
- Anthropic: `{"type":"error","error":{"type":"billing_error","message":"…"}}`

## Threshold alert

On each increase, the value before and after is compared. Crossing any threshold (dollar and token separately) is recorded only once, and only by one replica, using `SET NX` on `dirouter:budget:alerted:<id>:<period>:<kind>:<t>`, and the event is added to the list `dirouter:budget:alerts`.

The worker runs every 10 seconds (job `budget-alerts`) and writes this list to `audit_logs`:

```
action = budget.threshold_crossed, target_type = budget
diff = {threshold, kind, spent, limit, scope, scopeId, period, periodKey, at}
```

If the DB write fails, the events are returned to the list.

## Reconcile with the ledger

The job `budget-reconcile` in the worker runs every 5 minutes. For each budget, it computes the sum of `usage_ledger` for the current period. Scope column: `api_key_id`, `project_id` or `team_id`. It then reconciles the counter with an atomic Lua script:

| counter state                                       | action                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| missing (Valkey restart, outage during an increase) | equals the ledger                                                                                                       |
| quiet (no increase in the last 2 minutes)           | exactly equals the ledger, whether it was higher or lower (e.g. an event that went to the DLQ)                          |
| active                                              | only raised (`max(counter, ledger)`); the ledger lags a few seconds, and events in transit must not be subtracted twice |

Corrections are logged with `budget counters reconciled with ledger` and the drift list. The ledger is the source of truth for billing; the counter is only for fast decisions.

## Valkey outage

| failMode         | behavior                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| `open` (default) | the request passes. Lost increases are compensated by reconcile from the ledger |
| `closed`         | 429 `budget_exceeded` with "Budget check unavailable"                           |

## Verification (2026-11-08)

- **Tests:**
  - `apps/gateway/src/budget-guard.test.ts`: Valkey outage (open/closed), and with a real Valkey:
    - rejection of requests after the dollar and token cap
    - reset in the next period
    - the 50/80/100 thresholds fire exactly once with three simultaneous replicas
    - end to end: 429 with `insufficient_quota` and `billing_error`
  - `apps/worker/src/budgets.integration.test.ts`: a missing counter is restored, slow drift is corrected, an active counter is preserved, a second run has no effect, and alerts are recorded in audit_logs.
- **Through Traefik**, with a key that has a daily budget of 0.00001 dollars:
  - 4 requests returned 200, then 429 `budget_exceeded` (OpenAI: `insufficient_quota`; Anthropic: `billing_error`), with `Retry-After` until UTC midnight
  - the counter (1120 units, 72 tokens) exactly equaled the ledger sum (0.0000112 dollars, 72)
  - audit_logs had three rows, for 50, 80 and 100%
- **Counter deletion** (simulating loss): one request passed. The `budget-reconcile` job raised the counter from 280 to 1400 units (equal to the ledger), and the next request got 429 again.

---

<a id="persian"></a>

# Rate limit و همزمانی (کارت‌های ۵.۷ و ۶.۱)

DiRouter دو لایه محدودیت دارد:

| لایه                       | کجا                              | دقت    | هدف                                                                                                           |
| -------------------------- | -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| **rate limiter توزیع‌شده** | Valkey، مشترک بین همهٔ replicaها | سراسری | RPM، TPM و همزمانی برای کلید، پروژه و تیم                                                                     |
| **bulkhead**               | حافظهٔ هر replica                | محلی   | محافظت از خود node: سقف همزمانی provider و کلید با صف کوتاه ([gateway/internals.md](../gateway/internals.md)) |

## scopeها و تنظیم

| scope      | جدول / API                                    | فیلدها                          |
| ---------- | --------------------------------------------- | ------------------------------- |
| کلید مجازی | `virtual_keys` (`POST/PATCH /orgs/:org/keys`) | `rpm`، `tpm`، `maxConcurrency`  |
| پروژه      | `rate_limit_policies` با scope=PROJECT        | `rpm`، `tpm`، `max_concurrency` |
| تیم        | `rate_limit_policies` با scope=TEAM           | همان                            |

هر درخواست باید زیر سقف **همهٔ** scopeهایش باشد (کلید، پروژهٔ کلید، و تیم پروژه). همه با یک اسکریپت Lua اتمیک بررسی می‌شوند و اگر یکی رد کند هیچ‌کدام مصرف نمی‌شود. config از snapshot می‌آید (کارت ۳.۹) و تغییرش در کمتر از یک ثانیه به گیت‌وی می‌رسد.

## الگوریتم‌ها

ساعت مرجع `TIME` خود Valkey است، پس اختلاف ساعت نودها اثری ندارد.

- **RPM: پنجرهٔ لغزان دقیق** (sliding log)
  - هر درخواست پذیرفته‌شده یک عضو در ZSET `dirouter:rl:rpm:<scope>` با امتیاز زمان دارد. در هر ۶۰ ثانیهٔ دلخواه حداکثر `rpm` درخواست پذیرفته می‌شود و burst ابتدای دقیقه بعداً جبران نمی‌شود.
  - حافظه O(rpm) برای هر scope است.
  - `Retry-After` دقیقاً زمان خروج قدیمی‌ترین درخواست از پنجره است.
- **TPM: رزرو و تسویه**
  - سطل‌های یک‌ثانیه‌ای در HASH `dirouter:rl:tpm:<scope>`.
  - پیش از درخواست، تخمین رزرو می‌شود: ورودی با tokenizer سریع + `min(max_tokens ?? 1024, 8192)`.
  - بعد از پاسخ، اختلاف با usage واقعی (ورودی + خروجی) در همان سطل تسویه می‌شود. درخواست ناموفق تخمینش را پس می‌دهد.
  - یک درخواست بزرگ‌تر از کل سقف فقط وقتی پنجره خالی است پذیرفته می‌شود، تا برای همیشه گیر نکند.
- **همزمانی: semaphore با TTL**
  - ZSET `dirouter:rl:conc:<scope>` با امتیاز «زمان انقضا» (پیش‌فرض ۱۵ دقیقه).
  - با پایان درخواست (یا stream) حذف می‌شود. اگر نودی بمیرد، جایش با TTL پس گرفته می‌شود.

## پاسخ

پاسخ موفق (JSON و stream) از scope با کمترین درخواست باقی‌مانده این هدرها را دارد:

```
x-ratelimit-limit-requests: 60
x-ratelimit-remaining-requests: 59
x-ratelimit-reset-requests: 60s
x-ratelimit-limit-tokens: 100000        (اگر tpm دارد)
x-ratelimit-remaining-tokens: 98200
x-ratelimit-reset-tokens: 60s
```

رد شدن یعنی 429 با `Retry-After` (ثانیه) و `x-ratelimit-remaining-requests: 0`:

- OpenAI: `{"error":{"type":"rate_limit_error","code":"rate_limited","message":"Rate limit exceeded for key (requests)"}}`
- Anthropic: `{"type":"error","error":{"type":"rate_limit_error",...}}`

پیام scope (`key`، `project` یا `team`) و نوع (`requests`، `tokens` یا `concurrency`) را می‌گوید، ولی شناسه‌ها را نه.

## قطعی Valkey

limiter از اتصال جدای Valkey با `enableOfflineQueue: false` و مهلت ۱۰۰ms برای هر فرمان استفاده می‌کند. هر خطا یا کندی برای ۱ ثانیه حالت degraded را فعال می‌کند تا هر درخواست هزینهٔ timeout ندهد. رفتار با `settings.failMode`:

| failMode         | رفتار در قطعی                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open` (پیش‌فرض) | limiter محلی در حافظهٔ هر node با سهم `ceil(limit / تعداد نودهای زنده)`. تعداد نودها هر ۵ ثانیه از heartbeatها (`dirouter:gateway:node:*`) خوانده می‌شود و آخرین مقدار معتبر می‌ماند. |
| `closed`         | درخواست‌های scopeهای دارای سقف 429 «Rate limiter unavailable (fail-closed)» می‌گیرند؛ کلیدهای بدون سقف عادی کار می‌کنند.                                                              |

در هیچ حالتی قطعی Valkey خطای 5xx نمی‌دهد. دقت در حالت `open` کمتر است: limiter محلی تاریخچهٔ پنجره را ندارد. در دقیقهٔ قطعی ممکن است تا یک سقف کامل اضافه پذیرفته شود؛ بعد از برگشت Valkey، شمارش سراسری ادامه پیدا می‌کند.

بدون `VALKEY_URL` (اجرای تک‌نودی) limiter محلی با سهم کامل کار می‌کند.

وضعیت در `GET /internal/health` (با INTERNAL_TOKEN):

```
"rateLimiter": {"remote": …, "local": …, "rejected": …, "degraded": false, "nodes": 3}
```

## بررسی (۲۰۲۶-۱۱-۰۸)

- **تست‌ها:**
  - `apps/gateway/src/rate-limiter.test.ts`: ۶ تست limiter محلی و ۲ تست قطعی (Valkey مرده: fail-open محلی، fail-closed با 429). با `INTEGRATION_VALKEY_URL` هم ۵ تست روی Valkey واقعی:
    - سه نود با سقف ۶۰ روی پنجرهٔ فشردهٔ ۳ ثانیه‌ای در ۷٫۵ ثانیه: ۱۸۰ ± ۵٪
    - Retry-After
    - TPM بین دو نود
    - همزمانی سراسری
    - پس گرفتن جا با TTL
  - `apps/gateway/src/limits.test.ts`: هدرها در JSON و stream، 429 در هر دو فرمت، و سقف مشترک پروژه.
- **تست بار:**
  - چیدمان: سه replica از image production پشت Traefik با یک Valkey، و یک کلید با `rpm: 60` ساخته‌شده از control-api
  - بار: ۱۱ کلاینت هم‌زمان در ۱۵۰ ثانیه
  - نتیجه: ۱۸۰ درخواست پذیرفته (۶۰ / ۶۰ / ۶۰ در هر دقیقه، خطای صفر درصد)، ۳۶۸۲۲ تا 429، و صفر 5xx
  - توزیع بین نودها: ۶۱ / ۶۱ / ۵۸
  - تکرار ۱۳۰ ثانیه‌ای: باز ۱۸۰ پذیرفته، با شروع دسته‌ها در ۰٫۰۷s، ۶۰٫۰۷s و ۱۲۰٫۱s
  - با تحمل ۰٫۵ ثانیه برای jitter زمان پاسخ در لبهٔ پنجره، بیشینه در هر پنجرهٔ ۶۰ ثانیه‌ای دقیقاً ۶۰ بود
- **قطعی Valkey:**
  - `docker pause` روی Valkey به مدت ۲۰ ثانیه، وسط بار
  - صفر 5xx؛ ۱۱۷۵ درخواست کلید بدون سقف همه 200
  - هر نود یک بار به limiter محلی رفت (لاگ «local fallback») و بعد از برگشت Valkey به حالت سراسری برگشت

# بودجه (کارت ۶.۳)

بودجه سقف هزینه (دلار) یا توکن در یک دوره است:

| scope       | تنظیم                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| کلید        | `budgets` در `POST/PATCH /orgs/:org/keys` (حداکثر دو بودجه: روزانه و ماهانه) |
| پروژه / تیم | جدول `budgets` با scope=PROJECT یا TEAM                                      |

هر بودجه این فیلدها را دارد: `period` (`daily` یا `monthly`)، `limitUsd` و/یا `limitTokens`، و `alertThresholds` (پیش‌فرض `[50, 80, 100]`).

## شمارنده در Valkey

- **کلید**: `dirouter:budget:<budgetId>:<periodKey>`، که `periodKey` برابر `d:2026-11-08` یا `m:2026-11` است (**UTC**).
- **ریست خودکار**: شروع دوره یعنی کلید تازه. کلید قدیمی یک هفته بعد از پایان دوره با TTL پاک می‌شود.
- **فیلدها**:
  - `usd`: عدد صحیح به واحد 1e-8 دلار، همان دقت `Decimal(18,8)` ledger و بدون خطای float
  - `tokens`: ورودی + خروجی
  - `ts`: زمان آخرین افزایش
- **پیش از درخواست**: اگر شمارندهٔ هر بودجهٔ کلید، پروژه یا تیم به سقف رسیده باشد، درخواست رد می‌شود. هزینهٔ خود درخواست پیش از اجرا معلوم نیست، پس درخواستی که شروع شده تمام می‌شود و **درخواست بعدی** رد می‌شود. در نتیجه مصرف می‌تواند به اندازهٔ درخواست‌های هم‌زمانِ آخر از سقف بگذرد.
- **بعد از درخواست**: اسکریپت Lua شمارنده‌ها را با هزینه و توکن واقعی (همان `costUsd` رویداد مصرف) به‌طور اتمیک افزایش می‌دهد.

## پاسخ

429 با `Retry-After` تا شروع دورهٔ بعد:

- OpenAI: `{"error":{"type":"insufficient_quota","code":"budget_exceeded","message":"Daily key budget exceeded (USD 5)"}}`
- Anthropic: `{"type":"error","error":{"type":"billing_error","message":"…"}}`

## هشدار آستانه

با هر افزایش، مقدار قبل و بعد مقایسه می‌شود. عبور از هر آستانه (دلار و توکن جدا) با `SET NX` روی `dirouter:budget:alerted:<id>:<period>:<kind>:<t>` فقط یک بار و فقط توسط یک replica ثبت می‌شود و در فهرست `dirouter:budget:alerts` قرار می‌گیرد.

worker هر ۱۰ ثانیه (job `budget-alerts`) این فهرست را در `audit_logs` ثبت می‌کند:

```
action = budget.threshold_crossed، target_type = budget
diff = {threshold, kind, spent, limit, scope, scopeId, period, periodKey, at}
```

اگر نوشتن در DB شکست بخورد، رویدادها به فهرست برمی‌گردند.

## reconcile با ledger

job `budget-reconcile` در worker هر ۵ دقیقه، برای هر بودجه، جمع `usage_ledger` دورهٔ جاری را حساب می‌کند. ستون scope: `api_key_id`، `project_id` یا `team_id`. سپس با یک اسکریپت Lua اتمیک شمارنده را تطبیق می‌دهد:

| وضعیت شمارنده                                | اقدام                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| گم‌شده (ری‌استارت Valkey، قطعی هنگام افزایش) | برابر ledger                                                                                                    |
| آرام (بدون افزایش در ۲ دقیقهٔ اخیر)          | دقیقاً برابر ledger، چه بیشتر بوده چه کمتر (مثلاً رویدادی که به DLQ رفت)                                        |
| فعال                                         | فقط بالا کشیده می‌شود (`max(counter, ledger)`)؛ ledger چند ثانیه عقب است و رویدادهای در راه نباید دوبار کم شوند |

اصلاح‌ها با `budget counters reconciled with ledger` و فهرست drift لاگ می‌شوند. ledger منبع حقیقت صورت‌حساب است و شمارنده فقط برای تصمیم سریع است.

## قطعی Valkey

| failMode         | رفتار                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| `open` (پیش‌فرض) | درخواست عبور می‌کند. افزایش‌های ازدست‌رفته با reconcile از ledger جبران می‌شوند |
| `closed`         | 429 `budget_exceeded` با «Budget check unavailable»                             |

## بررسی (۲۰۲۶-۱۱-۰۸)

- **تست‌ها:**
  - `apps/gateway/src/budget-guard.test.ts`: قطعی Valkey (open/closed)، و با Valkey واقعی:
    - رد درخواست بعد از سقف دلار و توکن
    - ریست در دورهٔ بعد
    - آستانه‌های ۵۰/۸۰/۱۰۰ دقیقاً یک بار با سه replica هم‌زمان
    - انتها به انتها: 429 با `insufficient_quota` و `billing_error`
  - `apps/worker/src/budgets.integration.test.ts`: شمارندهٔ گم‌شده برمی‌گردد، drift آرام اصلاح می‌شود، شمارندهٔ فعال حفظ می‌شود، اجرای دوم بی‌اثر است، و هشدارها در audit_logs ثبت می‌شوند.
- **از Traefik**، با کلید دارای بودجهٔ روزانهٔ ۰٫۰۰۰۰۱ دلار:
  - ۴ درخواست 200، سپس 429 `budget_exceeded` (OpenAI: `insufficient_quota`؛ Anthropic: `billing_error`)، با `Retry-After` تا نیمه‌شب UTC
  - شمارنده (۱۱۲۰ واحد، ۷۲ توکن) دقیقاً برابر جمع ledger بود (۰٫۰۰۰۰۱۱۲۰ دلار، ۷۲)
  - audit_logs سه ردیف برای ۵۰، ۸۰ و ۱۰۰٪ داشت
- **حذف شمارنده** (شبیه‌سازی از دست رفتن): یک درخواست عبور کرد. job `budget-reconcile` شمارنده را از ۲۸۰ به ۱۴۰۰ واحد (برابر ledger) رساند و درخواست بعدی دوباره 429 گرفت.
