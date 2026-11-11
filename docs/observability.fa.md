[English](observability.md) · [فارسی](observability.fa.md)

<div dir="rtl">

# Observability و correlation

این سند قرارداد کارت‌های ۸.۱ و ۸.۲ است. gateway، control-api و worker خروجی متن Prometheus در `GET /metrics` دارند. endpointها روی همان پورت سرویس‌اند (`8080`، `3000` و `3100` در compose). در شبکهٔ production scrape باید فقط از شبکهٔ داخلی انجام شود؛ این endpointها نباید عموماً از Traefik منتشر شوند.

## قواعد مشترک

- همهٔ durationها **ثانیه**‌اند؛ نام histogram با `_seconds` تمام می‌شود.
- هر process registry و پیشوند runtime متفاوت دارد: `dirouter_gateway_`، `dirouter_control_api_` و `dirouter_worker_`.
- هیچ labelی برای request id، کاربر نهایی، سازمان، پروژه، تیم، virtual key، credential، IP یا prompt وجود ندارد.
- provider و model در gateway مقادیر پایدار snapshot (`providerId` و `modelId`) هستند. درخواستی که پیش از resolve رد می‌شود `provider="none"` می‌گیرد و model فقط نام مدل درخواستیِ schema است؛ نه متن prompt یا خطا.
- برای endpoint صحت scrape از `dirouter_queue_metrics_up` استفاده شود. خطای Valkey در scrape با سقف دو ثانیه مدیریت می‌شود و endpoint را از کار نمی‌اندازد.

## Gateway

| متریک                                                | نوع       | labelها                               | معنا                                                                                                                               |
| ---------------------------------------------------- | --------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `dirouter_gateway_requests_total`                    | Counter   | `provider`, `model`, `status`         | تمام درخواست‌های LLM، از جمله ردهای پیش از upstream؛ status فقط `success`/`error`                                                  |
| `dirouter_gateway_request_duration_seconds`          | Histogram | `provider`, `model`                   | latency کامل درخواست                                                                                                               |
| `dirouter_gateway_ttft_seconds`                      | Histogram | `provider`, `model`                   | زمان اولین بایت پاسخ stream؛ فقط وقتی TTFT موجود است                                                                               |
| `dirouter_gateway_request_attempts`                  | Histogram | `provider`, `model`                   | تعداد تلاش واقعی upstream؛ candidateهای skip شده شمرده نمی‌شوند                                                                    |
| `dirouter_gateway_upstream_attempt_duration_seconds` | Histogram | `provider`, `model`, `outcome`        | مدت هر تلاش، با attribution خود همان تلاش                                                                                          |
| `dirouter_gateway_admission_rejected_total`          | Counter   | `guard`, `reason`                     | رد rate limit، budget یا concurrency؛ reason فقط enumهای ثابت مثل `requests`, `tokens`, `concurrency`, `usd`, `unavailable`, `key` |
| `dirouter_gateway_active_streams`                    | Gauge     | —                                     | streamهای باز از admission تا پایان/abort                                                                                          |
| `dirouter_gateway_usage_outbox_events`               | Gauge     | —                                     | تعداد رویدادهای بافر حافظه + خطوط NDJSON باقی‌مانده در outbox محلی؛ هنگام scrape خوانده می‌شود                                     |
| `dirouter_gateway_breaker_state`                     | Gauge     | `scope`, `provider`, `model`, `state` | مقدار ۱ برای `open`/`half_open` و صفر برای `closed`؛ scope=`provider` یا `model`                                                   |

برای breaker مدل، label provider در صورت وجود در snapshot پر می‌شود. در breaker provider، label model خالی است. جست‌وجوی وضعیت باز مستقل از label state:

```promql
dirouter_gateway_breaker_state{state=~"open|half_open"} == 1
```

متریک‌های پیش‌فرض Node.js با پیشوند `dirouter_gateway_` نیز موجودند.

## Control API

| متریک                                           | نوع       | labelها                          | معنا                                                                                                                       |
| ----------------------------------------------- | --------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `dirouter_queue_jobs`                           | Gauge     | `queue`, `state`                 | تعداد jobهای صف‌های `usage`, `usage-dead`, `maintenance` در stateهای `waiting`, `active`, `delayed`, `failed`, `completed` |
| `dirouter_queue_metrics_up`                     | Gauge     | —                                | موفقیت آخرین خواندن وضعیت صف؛ یک یعنی همهٔ صف‌ها خوانده شده‌اند                                                            |
| `dirouter_control_api_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | زمان درخواست‌های مدیریتی؛ route الگوی Fastify است، نه URL با id                                                            |

این سرویس برای خواندن BullMQ اتصال اختصاصی metrics می‌سازد و آن را در shutdown می‌بندد. runtime metrics پیشوند `dirouter_control_api_` دارند.

## Worker

| متریک                                  | نوع       | labelها          | معنا                                                                                                                     |
| -------------------------------------- | --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `dirouter_queue_jobs`                  | Gauge     | `queue`, `state` | طول صف‌ها؛ همان قرارداد control-api                                                                                      |
| `dirouter_queue_metrics_up`            | Gauge     | —                | سلامت جمع‌آوری طول صف                                                                                                    |
| `dirouter_usage_events_written_total`  | Counter   | —                | رویدادهای usage که writer با موفقیت نوشته است                                                                            |
| `dirouter_usage_events_failed_total`   | Counter   | —                | تلاش‌های ناموفق نوشتن رویداد                                                                                             |
| `dirouter_usage_events_dead_total`     | Counter   | —                | رویدادهای رفته به dead-letter                                                                                            |
| `dirouter_worker_job_duration_seconds` | Histogram | `job`, `outcome` | زمان jobهای `usage`, `rollup`, `partitions`, `retention`, `budget-alerts`, `budget-reconcile`؛ outcome=`success`/`error` |

runtime metrics پیشوند `dirouter_worker_` دارند. نام `dirouter_worker_job_duration_seconds` برای usage و maintenance یکسان است تا یک query همهٔ زمان‌های job را پوشش دهد.

## نمونه queryها

```promql
# نرخ خطای gateway بر اساس provider (پنج دقیقه)
sum by (provider) (rate(dirouter_gateway_requests_total{status="error"}[5m]))
  / clamp_min(sum by (provider) (rate(dirouter_gateway_requests_total[5m])), 0.000001)

# p99 latency درخواست
histogram_quantile(0.99,
  sum by (le, provider, model) (rate(dirouter_gateway_request_duration_seconds_bucket[5m])))

# p95 TTFT
histogram_quantile(0.95,
  sum by (le, provider, model) (rate(dirouter_gateway_ttft_seconds_bucket[5m])))

# backlog مصرف و قطعی جمع‌آوری صف
dirouter_gateway_usage_outbox_events
sum by (queue) (dirouter_queue_jobs{state=~"waiting|delayed|active"})
dirouter_queue_metrics_up == 0
```

هشدار اولیه باید علاوه بر نرخ خطا، رشد outbox، backlog صف، `dirouter_queue_metrics_up == 0` و breaker باز را پوشش دهد.

## Correlation با X-Request-Id

1. Traefik هدر `X-Request-Id` ورودی را حفظ می‌کند.
2. gateway و control-api مقدار ورودی معتبر (`[\w.-]{1,128}`) را می‌پذیرند؛ در غیر این صورت `req_<ULID>` می‌سازند.
3. همان مقدار در response header `X-Request-Id` برمی‌گردد؛ در stream و خطا نیز باقی می‌ماند.
4. در gateway فیلد JSON `requestId` لاگ‌ها و `requestId` رویداد مصرف همان مقدار است.
5. UsageSink رویداد را با `idempotencyKey=requestId` به BullMQ می‌دهد. worker پس از parse، در لاگ `usage event written` یا خطای نوشتن، همان `requestId` را می‌نویسد. dead-letter نیز در صورت معتبر بودن رویداد همین فیلد را دارد.

بنابراین جست‌وجوی مقدار request id در log aggregation باید لاگ `request completed` در gateway و `usage event written` در worker را با هم نشان دهد. control-api نیز برای هر پاسخ HTTP یک لاگ `request` با `requestId`، method، URL، status و زمان دارد.

نمونهٔ JSON (فیلدهای زمان/سطح/pid حذف شده‌اند):

```json
{"service":"gateway","requestId":"req_abc","msg":"request completed","status":"success","httpStatus":200,"provider":"prv_openai","model":"mdl_gpt","stream":true,"latencyMs":312,"ttftMs":74,"attempts":1}
{"service":"worker","requestId":"req_abc","msg":"usage event written","jobId":"req_abc","status":"written","latencyMs":312}
```

## حریم خصوصی لاگ

- لاگ پایان gateway یک allowlist از metadata است: request id، status، HTTP status، provider/model id، stream، latency/TTFT، تعداد attempt و error code ثابت.
- لاگ worker نیز فقط request/job id، نتیجه و latency را دارد؛ کل event سریال نمی‌شود.
- prompt، response، پیام‌ها، tool arguments، body، credential، endUser و organization/project/key id به‌طور پیش‌فرض لاگ نمی‌شوند.
- Pino فیلدهای حساس شناخته‌شده مثل authorization، api key، cookie، secret، password و token را redact می‌کند. redaction جای allowlist را نمی‌گیرد: فیلد جدید باید پیش از افزودن به لاگ بررسی شود.
- خطاهای upstream ممکن است متن provider داشته باشند و در لاگ خطای سرور ظاهر شوند؛ body درخواست یا پاسخ کاربر عمداً به exception/log افزوده نمی‌شود. سطح پیش‌فرض `info` است و افزایش آن به `debug` نیز prompt logging فعال نمی‌کند.
- رویداد usage و Postgres برای محاسبهٔ هزینه و صفحهٔ logs metadata لازم را دارند؛ این داده‌ها با «لاگ ساخت‌یافته» یکی نیستند و نباید کل رویداد را در لاگ چاپ کرد.

</div>
