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

| متریک                                                | نوع       | labelها                               | معنا                                                                                                                                 |
| ---------------------------------------------------- | --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `dirouter_gateway_requests_total`                    | Counter   | `provider`, `model`, `status`         | تمام درخواست‌های LLM، از جمله ردهای پیش از upstream؛ status فقط `success`/`error`                                                    |
| `dirouter_gateway_request_duration_seconds`          | Histogram | `provider`, `model`                   | latency کامل درخواست                                                                                                                 |
| `dirouter_gateway_ttft_seconds`                      | Histogram | `provider`, `model`                   | زمان اولین بایت پاسخ stream؛ فقط وقتی TTFT موجود است                                                                                 |
| `dirouter_gateway_request_attempts`                  | Histogram | `provider`, `model`                   | تعداد تلاش واقعی upstream؛ candidateهای skip شده شمرده نمی‌شوند                                                                      |
| `dirouter_gateway_upstream_attempt_duration_seconds` | Histogram | `provider`, `model`, `outcome`        | مدت هر تلاش، با attribution خود همان تلاش                                                                                            |
| `dirouter_gateway_admission_rejected_total`          | Counter   | `guard`, `reason`                     | رد rate limit، budget یا concurrency؛ reason فقط enumهای ثابت مثل `requests`, `tokens`, `concurrency`, `usd`, `unavailable`, `key`   |
| `dirouter_gateway_guardrail_unknown_total`           | Counter   | `type`                                | سیاست guardrail فعالی که این گیت‌وی نوعش را اجرا نمی‌کند و کنار گذاشته شد (کارت ۲۳.۱)؛ باید صفر بماند                                |
| `dirouter_gateway_guardrail_calls_total`             | Counter   | `type`، `outcome`                     | فراخوانی مدل در guardrailهای تعدیل محتوا و طبقه‌بند (کارت‌های ۲۳.۲ و ۲۳.۳)؛ `outcome` یکی از `pass`، `flagged`، `timeout` یا `error` |
| `dirouter_gateway_active_streams`                    | Gauge     | —                                     | streamهای باز از admission تا پایان/abort                                                                                            |
| `dirouter_gateway_usage_outbox_events`               | Gauge     | —                                     | تعداد رویدادهای بافر حافظه + خطوط NDJSON باقی‌مانده در outbox محلی؛ هنگام scrape خوانده می‌شود                                       |
| `dirouter_gateway_breaker_state`                     | Gauge     | `scope`, `provider`, `model`, `state` | مقدار ۱ برای `open`/`half_open` و صفر برای `closed`؛ scope=`provider` یا `model`                                                     |

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

## رهگیری توزیع‌شده با OpenTelemetry (کارت ۱۷.۲)

> کد: `apps/gateway/src/tracing.ts`. بدون وابستگی به SDK: spanها به‌صورت OTLP/HTTP JSON با `fetch` ارسال می‌شوند.

به‌صورت پیش‌فرض خاموش است. از تنظیمات گیت‌وی روشن می‌شود (`PUT /orgs/:orgId/config/settings`) و بدون ری‌استارت روی همهٔ replicaها اعمال می‌شود:

```json
{
  "tracing": {
    "enabled": true,
    "endpoint": "http://otel-collector:4318/v1/traces",
    "serviceName": "dirouter-gateway",
    "sampleRatio": 0.1
  }
}
```

| تنظیم         | پیش‌فرض            | معنی                                                          |
| ------------- | ------------------ | ------------------------------------------------------------- |
| `enabled`     | `false`            | کلید اصلی؛ بدون `endpoint` چیزی ثبت نمی‌شود                   |
| `endpoint`    | ندارد              | آدرس OTLP/HTTP یک collector (Tempo، Jaeger یا OTel collector) |
| `serviceName` | `dirouter-gateway` | ویژگی `service.name`                                          |
| `sampleRatio` | `0.1`              | سهم درخواست‌های **بدون parent** که ثبت می‌شوند (۰ تا ۱)       |

**انتشار (W3C Trace Context).** هدر ورودی `traceparent` ادامه داده می‌شود: span گیت‌وی به trace فراخواننده می‌پیوندد و span فراخواننده parent آن است. هر تلاش upstream هم `traceparent` خودش را برای provider می‌فرستد؛ پس یک trace از کلاینت تا گیت‌وی و فراخوانی upstream ادامه دارد.

**نمونه‌برداری مبتنی بر parent است.** درخواستی با `traceparent` نمونه‌برداری‌شده (`…-01`) همیشه ثبت می‌شود؛ با parent نمونه‌برداری‌نشده (`…-00`) هرگز؛ و درخواست‌های بدون هدر با `sampleRatio` نمونه‌برداری می‌شوند. با `sampleRatio: 0` فقط traceهایی ثبت می‌شوند که فراخواننده از قبل تصمیم به ثبتشان گرفته است. درخواست نمونه‌برداری‌نشده فقط هزینهٔ ساخت دو شناسهٔ تصادفی را دارد.

**Spanها.**

| Span               | نوع    | ویژگی‌ها                                                                                                                                                                                      |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.request`  | server | `gateway.inbound_api`، `gateway.model`، `gateway.stream`، `gateway.request_id` و سپس `gateway.provider`، `gateway.resolved_model`، `gateway.attempts`، `gateway.cache` یا `gateway.guardrail` |
| `gateway.upstream` | client | یکی به ازای هر تلاش (retry، فال‌بک یا hedge): `gateway.provider`، `gateway.resolved_model`، `gateway.credential` و در صورت خطا `gateway.error_class`                                          |

از کارت ۲۴.۳ نام span تلاش upstream به شکل `{gen_ai.operation.name} {مدل upstream}` است (مثلاً `chat gpt-4o`) و هر دو span ویژگی‌های GenAI semantic conventions را هم دارند؛ بخش بعد را ببینید. با `tracing.attributes: "legacy"` دقیقاً همین نام‌ها و ویژگی‌های جدول بالا ارسال می‌شوند.

ویژگی‌های span فقط متادیتا هستند: هیچ prompt، پاسخ یا رازی ضمیمه نمی‌شود. `gateway.request_id` همان `X-Request-Id` لاگ‌هاست؛ پس trace و خط‌های لاگ را می‌توان به هم وصل کرد.

**ارسال.** spanها دسته‌ای و هر ثانیه (یا با رسیدن به ۲۰۰ span) ارسال می‌شوند. اگر collector کند یا خاموش باشد، دسته دور ریخته می‌شود (حداکثر ۵۰۰۰ span بافر می‌شود) و مسیر درخواست هرگز تحت تأثیر قرار نمی‌گیرد.

## GenAI semantic conventions، متریک و لاگ OTLP (کارت ۲۴.۳)

> کد: `apps/gateway/src/genai.ts`، `apps/gateway/src/tracing.ts` و `apps/gateway/src/otlp-export.ts`.

**نسخهٔ هدف: OpenTelemetry semantic conventions نسخهٔ v1.41.0** (قراردادهای GenAI با وضعیت _Development_). نسخهٔ v1.41.0 آخرین انتشار مخزن اصلی `semantic-conventions` است که قراردادهای GenAI را دارد؛ از v1.42.0 این قراردادها به مخزن [`open-telemetry/semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai) منتقل شده‌اند و اولین انتشار آن (v0.1.0) نام متریک‌های inference را عوض کرده است (`gen_ai.client.inference.duration` و هیستوگرام‌های جدای توکن ورودی و خروجی). چون قراردادها هنوز Development هستند، نسخه این‌جا ثابت شده و spanها و متریک‌های ارسالی `schemaUrl: https://opentelemetry.io/schemas/1.41.0` دارند. رفتن به نسخهٔ جدیدتر تغییری آگاهانه در `genai.ts` و همین بخش است.

انتخاب‌های انجام‌شده بر اساس v1.41.0:

- `gen_ai.provider.name` ارسال می‌شود؛ `gen_ai.system` که منسوخ شده (تغییر نام در v1.37.0) نه.
- تلاش upstream همان span استنتاج است: نوع CLIENT و نام `{gen_ai.operation.name} {gen_ai.request.model}`. span درخواست همچنان `gateway.request` (نوع SERVER) است و ویژگی‌های درخواست را دارد اما **مصرف توکن ندارد**، تا backendی که مصرف را روی spanها جمع می‌زند یک فراخوانی را دو بار حساب نکند. پاسخ از کش span upstream ندارد و مصرفش روی span درخواست است.
- ویژگی‌های محتوا (`gen_ai.input.messages`، `gen_ai.output.messages` و `gen_ai.system_instructions`) در قراردادها opt-in هستند و هرگز ارسال نمی‌شوند.

| ویژگی                                                                                                                      | span upstream (client)                                                                                 | span درخواست (server)                 |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `gen_ai.operation.name`                                                                                                    | `chat`؛ برای `generateContent` جمینای `generate_content`                                               | همان                                  |
| `gen_ai.provider.name`                                                                                                     | از نوع provider (جدول زیر)                                                                             | providerی که پاسخ داد                 |
| `gen_ai.request.model`                                                                                                     | مدل upstream که به provider فرستاده شد                                                                 | مدل، alias یا comboی که کلاینت فرستاد |
| `gen_ai.request.max_tokens`، `temperature`، `top_p`، `top_k`، `seed`، `stop_sequences`                                     | اگر کلاینت تعیین کرده باشد                                                                             | همان                                  |
| `gen_ai.response.id`، `gen_ai.response.model`، `gen_ai.response.finish_reasons`                                            | از پاسخ (دلیل پایان با مقادیر canonical دی‌روتر: `stop`، `length`، `tool_calls`، `content_filter` و …) | مدل و دلیل پایان                      |
| `gen_ai.usage.input_tokens`، `gen_ai.usage.output_tokens`                                                                  | همیشه در موفقیت                                                                                        | فقط در پاسخ از کش                     |
| `gen_ai.usage.cache_read.input_tokens`، `gen_ai.usage.cache_creation.input_tokens`، `gen_ai.usage.reasoning.output_tokens` | اگر صفر نباشد                                                                                          | —                                     |
| `server.address`، `server.port`                                                                                            | میزبان و پورت base URL provider                                                                        | —                                     |
| `error.type`                                                                                                               | کلاس خطا (`timeout`، `rate_limit` و …) در شکست                                                         | دلیل رد درخواست                       |

| نوع provider   | `gen_ai.provider.name`              |
| -------------- | ----------------------------------- |
| `openai`       | `openai`                            |
| `azure-openai` | `azure.ai.openai`                   |
| `anthropic`    | `anthropic`                         |
| `gemini`       | `gcp.gemini`                        |
| `vertex`       | `gcp.vertex_ai`                     |
| `bedrock`      | `aws.bedrock`                       |
| `cohere`       | `cohere`                            |
| `mistral`      | `mistral_ai`                        |
| هر نوع دیگر    | خود نوع (مثلاً `openai-compatible`) |

**حفظ نام‌های قدیمی.** تنظیم `tracing.attributes` تعیین می‌کند چه ارسال شود:

| مقدار            | نام spanها                                | ویژگی‌ها                                           |
| ---------------- | ----------------------------------------- | -------------------------------------------------- |
| `both` (پیش‌فرض) | `gateway.request` و `{operation} {model}` | `gen_ai.*`، `error.type`، `server.*` و `gateway.*` |
| `gen_ai`         | `gateway.request` و `{operation} {model}` | فقط قراردادها                                      |
| `legacy`         | `gateway.request` و `gateway.upstream`    | فقط `gateway.*`، مثل پیش از کارت ۲۴.۳              |

داشبوردها و queryهایی که روی `gateway.*` ساخته شده‌اند با پیش‌فرض کار می‌کنند؛ وقتی به قراردادها منتقل شدند به `gen_ai` بروید.

**متریک OTLP.** با فعال بودن `tracing.metrics`، گیت‌وی کل registry پرومتئوس خود را هر `intervalSeconds` به endpoint متریک OTLP/HTTP می‌فرستد (temporality تجمعی؛ counter، gauge و هیستوگرام با همان نام پرومتئوس، به‌علاوهٔ متریک‌های پیش‌فرض Node.js). `/metrics` همان‌طور باقی می‌ماند. دو هیستوگرام از قراردادها پیروی می‌کنند و با نام قراردادی و کلیدهای `gen_ai.*` ارسال می‌شوند:

| نام OTLP (v1.41.0)                 | نام پرومتئوس                                                | واحد      | ویژگی‌ها                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `gen_ai.client.token.usage`        | `dirouter_gateway_gen_ai_client_token_usage`                | `{token}` | `gen_ai.operation.name`، `gen_ai.provider.name`، `gen_ai.request.model`، `gen_ai.response.model` و `gen_ai.token.type` (`input`/`output`) |
| `gen_ai.client.operation.duration` | `dirouter_gateway_gen_ai_client_operation_duration_seconds` | `s`       | همان‌ها بدون نوع توکن، به‌علاوهٔ `error.type` در شکست                                                                                     |

هر دو به ازای هر تلاش upstream ثبت می‌شوند (توکن فقط روی تلاشی که پاسخ داد) و مرز سطل‌ها همان پیشنهاد قراردادهاست. در پرومتئوس برچسب‌ها `operation`، `provider`، `request_model`، `response_model`، `token_type` و `error_type` هستند.

**لاگ OTLP.** با فعال بودن `tracing.logs`، هر خط لاگ JSON گیت‌وی که سطحش دست‌کم `level` باشد به‌صورت یک log record در OTLP هم ارسال می‌شود: `msg` بدنه، `level` شدت و سایر فیلدها ویژگی می‌شوند (شیءها به‌صورت متن JSON). این‌ها همان خط‌های stdout هستند، پس قواعد حریم خصوصی لاگ در بالا بدون تغییر برقرارند. recordها هر ثانیه دسته‌ای ارسال می‌شوند؛ حداکثر ۵۰۰۰ منتظر می‌مانند و بقیه دور ریخته می‌شوند.

```json
{
  "tracing": {
    "enabled": true,
    "endpoint": "http://otel-collector:4318/v1/traces",
    "attributes": "both",
    "metrics": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318/v1/metrics",
      "intervalSeconds": 30
    },
    "logs": { "enabled": true, "endpoint": "http://otel-collector:4318/v1/logs", "level": "info" }
  }
}
```

| تنظیم                     | پیش‌فرض | معنی                                                      |
| ------------------------- | ------- | --------------------------------------------------------- |
| `attributes`              | `both`  | `both`، `gen_ai` یا `legacy`؛ بالا را ببینید              |
| `metrics.enabled`         | `false` | ارسال متریک OTLP؛ مستقل از `tracing.enabled`              |
| `metrics.endpoint`        | ندارد   | URL متریک OTLP/HTTP                                       |
| `metrics.intervalSeconds` | `30`    | ۵ تا ۳۶۰۰                                                 |
| `logs.enabled`            | `false` | ارسال لاگ OTLP؛ مستقل از `tracing.enabled`                |
| `logs.endpoint`           | ندارد   | URL لاگ OTLP/HTTP                                         |
| `logs.level`              | `info`  | پایین‌ترین سطح ارسالی: `debug`، `info`، `warn` یا `error` |

مانند traceها، ارسال متریک و لاگ هرگز درخواست را معطل نمی‌کند: ارسال ناموفق دور ریخته و شمرده می‌شود و آخرین دسته هنگام خاموشی ارسال می‌شود. backendهایی که GenAI conventions را می‌خوانند (Langfuse، Phoenix، Datadog LLM Observability و دیگران) هر span upstream را به‌عنوان یک فراخوانی LLM با مدل، provider و توکن نشان می‌دهند، بدون نگاشت دستی.

</div>
