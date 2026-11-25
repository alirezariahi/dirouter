[English](routing.md) · [فارسی](routing.fa.md)

<div dir="rtl">

# مسیریابی، فال‌بک و سلامت

> کد: `packages/routing` (کارت‌های ۵.۱، ۵.۳، ۵.۵، ۵.۶). بدون I/O؛ index یک بار به ازای هر ConfigSnapshot ساخته می‌شود.

همچنین ببینید: [مسیریابی در سطح درخواست](request-routing.fa.md): ترجیح ارائه‌دهنده، مدل‌های فال‌بک و سیاست مسیریابی (اسپرینت ۵).

## ۱. resolve نام مدل

```
نام کلاینت ──► alias؟ ──► مدل | combo
          └─► slug combo؟ ──► combo
          └─► slug مدل؟  ──► مدل
          └─► model_not_found (404)
```

- جستجو همیشه در محدودهٔ **سازمانِ کلید** است؛ نام‌های سازمان دیگر دیده نمی‌شوند.
- اگر `allowedModels` کلید خالی نباشد، نام درخواستی باید در آن باشد (`model_not_allowed`، 403).

## ۲. ترتیب هدف‌ها (استراتژی combo)

| استراتژی      | رفتار                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| `priority`    | به ترتیب `order` (fill-first): همیشه اولی، بعد فال‌بک                                  |
| `weighted`    | ترتیب تصادفی وزنی بدون جایگذاری؛ هدف با وزن ۰ همیشه آخر                                |
| `round-robin` | شروع چرخشی؛ شمارنده به ازای (combo، کلید) — هر کلید چرخش خودش را دارد (sticky per key) |

credentialهای هر مدل هم به‌صورت تصادفی وزنی (`weight`) مرتب می‌شوند و هر جفت (مدل، credential) یک **کاندیدا** است.

## ۳. فیلترها

هر هدف در این حالت‌ها کنار گذاشته می‌شود (دلیل در `skipped` برای لاگ و شبیه‌ساز):
`model_disabled`، `provider_disabled`، `context_window` (تخمین توکن ورودی + max_tokens بیشتر از context مدل)، `provider_circuit_open`، `model_circuit_open`، `credential_disabled`، `credential_cooldown`.
اگر کاندیدایی نماند: `no_available_provider` (503).

## ۴. اجرا: retry و فال‌بک

برای هر کاندیدا به ترتیب:

1. تلاش؛ اگر موفق → پایان.
2. اگر خطا `retryable` است (server، overloaded، timeout، connection) و تلاش‌ها کمتر از `retry.maxAttempts` → صبر (Retry-After یا backoff نمایی با full jitter: `random(0, min(maxDelay, base·2^(n-1)))`) و تلاش دوباره روی همان کاندیدا.
3. `rate_limit` روی همان credential تکرار نمی‌شود؛ مستقیم کاندیدای بعدی (معمولاً credential دیگر همان مدل).
4. فال‌بک فقط اگر کلاس خطا `fallbackAllowed` باشد **و** در `combo.fallbackOn` باشد. `bad_request` و `content_filter` هرگز فال‌بک ندارند ([errors.md](errors.fa.md)).
5. بعد از خطای سطح provider (server، overloaded، connection، timeout)، بقیهٔ کاندیداهای همان provider در این درخواست رد می‌شوند.
6. بعد از `context_length` فقط کاندیداهای با context window بزرگ‌تر امتحان می‌شوند.

محدودیت‌ها:

- **deadline** کل درخواست؛ صبری که از deadline بگذرد انجام نمی‌شود.
- **retry budget** سراسری هر نود: در هر پنجرهٔ ۱۰ ثانیه، retry و فال‌بک حداکثر ۲۰٪ درخواست‌ها + ۱۰. در قطعی کامل، ترافیک به upstream چند برابر نمی‌شود.
- **committed**: اگر بخشی از stream به کلاینت رفته، هیچ تلاش دیگری انجام نمی‌شود.
- قطع کلاینت (`AbortSignal`) همهٔ تلاش‌ها را متوقف می‌کند.

همهٔ تلاش‌ها (`provider`، `model`، `credential`، نتیجه، کلاس خطا، status، latency و زمان شروع) در `attempts` ثبت می‌شوند. این آرایه در UsageEvent می‌آید و worker آن را در ستون JSONB به نام `request_log.attempts` ذخیره می‌کند. مثال واقعی در dev برای alias `gpt-4.1`:

```sql
SELECT jsonb_array_length(attempts), attempts->0->>'outcome', attempts->-1->>'providerId'
FROM request_log WHERE requested_model = 'gpt-4.1';
-- 3 | error | mock      (دو خطای 503 روی mock-down، سپس موفقیت روی mock)
```

### timeoutهای چندلایه

| timeout       | پیش‌فرض | چه چیزی را می‌سنجد                                                                            | بعد از آن                                          |
| ------------- | ------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `connectMs`   | 5s      | TCP و TLS handshake (`connect.timeout` در undici)                                             | خطای `timeout` با امکان retry و فال‌بک             |
| `firstByteMs` | 60s     | فقط stream: تا هدر **و** اولین chunk. در non-stream اعمال نمی‌شود چون مدل کل پاسخ را می‌سازد. | پیش از ارسال بایت، فال‌بک                          |
| `idleMs`      | 60s     | فاصلهٔ بین دو chunk در stream                                                                 | اگر بایت رفته باشد، خطای stream (فال‌بک ممکن نیست) |
| `totalMs`     | 10m     | کل تلاش                                                                                       | مثل بالا                                           |

لایه‌ها فیلدبه‌فیلد روی هم قرار می‌گیرند: پیش‌فرض‌های `settings.defaultTimeouts`، سپس `combo.timeouts`، سپس `provider.timeouts`. حرف آخر با provider است، چون محدودیت واقعی upstream را او می‌داند (مثلاً `mock-long` با total پانزده‌دقیقه‌ای). هر timeout با `AbortController` به upstream می‌رسد و اتصال را واقعاً می‌بندد.

تست جدای هر لایه در `apps/gateway/src/upstream.test.ts`، روی سرورهای خام TCP/HTTP:

- connect با سروری که handshake TLS را تمام نمی‌کند: زیر ۱.۵ ثانیه، کلاس `timeout`، fallbackAllowed.
- TTFT: یک بار بدون هدر و یک بار با هدر بدون chunk.
- idle: stream که بعد از chunk اول می‌ایستد.
- total: stream که مدام chunk می‌فرستد ولی از total می‌گذرد.
- عدم اعمال TTFT در non-stream.
- بستن upstream زیر ۱ ثانیه بعد از قطع کلاینت.

## ۵. circuit breaker (provider و مدل)

- پنجرهٔ لغزان ۳۰ ثانیه (۱۰ سطل)، حداقل ۱۰ درخواست، آستانهٔ ۵۰٪ خطا.
- فقط خطاهای سلامت سرویس شمرده می‌شوند (server، overloaded، timeout، connection)؛ خطای کاربر یا کلید breaker را باز نمی‌کند.
- `CLOSED → OPEN` (۱۵ ثانیه، با هر باز شدن پشت‌سرهم دو برابر تا ۵ دقیقه) `→ HALF_OPEN` (۱ probe هم‌زمان؛ ۲ موفقیت → CLOSED؛ شکست → OPEN).
- وضعیت در حافظهٔ هر نود است؛ تغییرات از طریق Valkey به نودهای دیگر اعلام می‌شوند. قطعی Valkey فقط همگام‌سازی را متوقف می‌کند.

### همگام‌سازی بین replicaها

کد: `apps/gateway/src/health-sync.ts`

- هر تغییر محلی در `HealthRegistry` روی کانال `dirouter:health` در Valkey منتشر می‌شود: باز یا بسته شدن breaker، cooldown، lockout و غیرفعال شدن credential. بقیهٔ replicaها آن را با `applyRemote` اعمال می‌کنند. پیام خود نود نادیده گرفته می‌شود و پیام خراب یا ناشناخته رد می‌شود.
- **Valkey منبع وضعیت نیست، فقط هم‌خبری است.** در قطعی، انتشار بی‌صدا رد می‌شود (شمارندهٔ `dropped`) و هر نود با breaker محلی خودش ادامه می‌دهد. بعد از برگشت Valkey، ioredis اشتراک را خودکار برقرار می‌کند.
- `GET /internal/health` (وضعیت breakerها و credentialها) فقط با `Authorization: Bearer $INTERNAL_TOKEN` است. بدون آن 404 می‌دهد، چون این مسیر از Traefik هم در دسترس است.

بررسی در compose با دو replica از گیت‌وی (۲۰۲۶-۱۱-۰۷):

| گام                                                        | نتیجه                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ۶ خطا فقط به replica 1 (`mock/down`)                       | breaker `mock-down` در **هر دو** replica باز شد                                                                        |
| Valkey متوقف شد؛ ۶ خطا فقط به replica 2 (`mock/deadproxy`) | breaker در replica 2 به‌طور محلی باز شد. `mock/small` همچنان 200 داد. replica 1 خبردار نشد، که در قطعی انتظارش می‌رود. |
| Valkey دوباره بالا آمد؛ 429 روی replica 1                  | cooldown همان credential در replica 2 دیده شد (اشتراک خودکار برقرار شد)                                                |

تست‌ها در `health-sync.test.ts`: انتشار breaker و cooldown، قطعی Valkey، پیام خراب، و دو نود روی Valkey واقعی (در job integration در CI).

## ۶. cooldown و lockout

| رویداد                                           | اثر                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 429 عمومی                                        | cooldown همان credential تا Retry-After؛ بدون آن ۱۰ ثانیه × ۲^(تکرار−۱) تا ۵ دقیقه |
| 429 مخصوص مدل (پیام شامل model / tokens per min) | lockout فقط همان مدل روی همان credential                                           |
| 401/403 یا `insufficient_quota`                  | غیرفعال‌سازی credential (یک ساعت یا تا تغییر کلید) + رویداد هشدار                  |

پایان cooldown خودکار است و credentialهای دیگر همان provider کار می‌کنند. وضعیت‌ها از `/health/runtime` و صفحهٔ Health دیده می‌شوند.

## ۷. مثال combo

```json
{
  "slug": "smart",
  "strategy": "priority",
  "targets": [
    { "modelId": "anthropic/claude-sonnet-4-5", "order": 0 },
    { "modelId": "openai/gpt-4.1", "order": 1 },
    { "modelId": "deepseek/deepseek-chat", "order": 2 }
  ],
  "fallbackOn": [
    "rate_limit",
    "overloaded",
    "server",
    "timeout",
    "connection",
    "auth",
    "not_found",
    "context_length"
  ],
  "retry": { "maxAttempts": 2, "baseDelayMs": 200, "maxDelayMs": 2000 }
}
```

## ساخت combo از API (کارت ۳.۸)

```bash
A=https://admin.example.com/api/v1/orgs/$ORG
# مدل از کاتالوگ: قیمت، context و قابلیت‌ها خودکار پر می‌شود
curl -X POST $A/models -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"providerId":"'$OPENAI'","upstreamModel":"gpt-4.1","catalogKey":"openai/gpt-4.1"}'
# combo سه‌هدفه: اول gpt-4.1 و در صورت خطای rate_limit، server یا timeout بعدی‌ها
curl -X POST $A/combos -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slug":"smart","strategy":"priority","retryMaxAttempts":3,
       "fallbackOn":["rate_limit","server","timeout"],
       "targets":[{"modelId":"'$GPT41'"},{"modelId":"'$CLAUDE'"},{"modelId":"'$DEEPSEEK'"}]}'
# alias برای کلاینت‌ها
curl -X POST $A/aliases -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slug":"gpt-best","comboId":"'$SMART'"}'
```

اعتبارسنجی:

- target تکراری رد می‌شود (`422`، «duplicate target»).
- مدل ناموجود یا مال سازمان دیگر رد می‌شود (`422`، «unknown model»).
- کلاس خطای نامعتبر در `fallbackOn` رد می‌شود.
- نام مدل، alias و combo در یک فضای نام مشترک‌اند و تکرار 409 می‌دهد.
- مدلی که در combo یا alias استفاده شده، و comboیی که alias دارد، حذف نمی‌شود (409).

استراتژی‌ها:

- `priority`: به ترتیب `order`.
- `weighted`: تصادفی با `weight`.
- `round-robin`: نوبتی بین نودها.

اگر `fallbackOn` خالی باشد، پیش‌فرض `DEFAULT_FALLBACK_ON` استفاده می‌شود.

## کاتالوگ قیمت بدون migration

> از کارت ۲۷.۵ کاتالوگ با worker از منبع‌های قیمت بیرونی هم همگام می‌شود؛ [catalog-sync.fa.md](../catalog-sync.fa.md) را ببینید. `catalog.json` همراه کد نقطهٔ شروع و پشتیبان است.

- `packages/model-catalog/src/catalog.json` فایل نسخه‌دار (`version: YYYY.MM.DD`) قیمت و قابلیت مدل‌های اصلی است. `GET /orgs/:orgId/catalog` آن را نشان می‌دهد.
- مدلی که با `catalogKey` ساخته شده، با `POST /orgs/:orgId/models/sync-catalog` به قیمت و context نسخهٔ تازهٔ کاتالوگ به‌روز می‌شود. پس به‌روزرسانی قیمت فقط تغییر JSON و deploy است و migration لازم ندارد.
- قیمت دستی (`PATCH` با `pricing`) مدل را `priceOverride: true` می‌کند و `catalogKey` آن را نگه می‌دارد، تا نه `sync-catalog` و نه همگام‌سازی قیمت کاتالوگ آن را بازنویسی کند؛ `PATCH` با `followCatalog: true` آن را به قیمت کاتالوگ برمی‌گرداند.
- قابلیت‌های `documents` و `audioInput` (کارت ۲۷.۲) می‌گویند مدل در چت ورودی PDF/فایل و صوت می‌پذیرد یا نه. `false` چنین درخواست‌هایی را از مدل دور نگه می‌دارد؛ مقدار خالی تصمیم را به توان ترجمهٔ نوع provider می‌سپارد. [ترجمه](../gateway/translation.fa.md#documents-and-audio) را ببینید.
- js-tiktoken برای `@dirouter/model-catalog` یک peer اختیاری است. گیت‌وی و control-api (که تست زندهٔ guardrail در آن توکن‌ها را مثل گیت‌وی می‌شمارد) آن را اعلام کرده‌اند و در ایمیجشان نگه می‌دارند؛ بقیهٔ اپ‌ها فقط `@dirouter/model-catalog/catalog` را import می‌کنند.

## مسیریابی پیشرفته (اسپرینت ۲)

> کد: `packages/routing/src/{router,stats,hedging}.ts`، `apps/gateway/src/{proxy,health-probe}.ts` (کارت‌های ۱۲.۱ تا ۱۲.۵).

### استراتژی‌های هوشمند combo (۱۲.۱)

| استراتژی     | ترتیب هدف‌ها                                                                       |
| ------------ | ---------------------------------------------------------------------------------- |
| `latency`    | کمترین امتیاز تأخیر اول. امتیاز = PeakEWMA × (۱ + تعداد درخواست در جریان)          |
| `cost`       | ارزان‌ترین برآورد قیمت همین درخواست (توکن ورودی تخمینی + سقف خروجی × قیمت مدل) اول |
| `least-used` | کمترین (درخواست ۶۰ ثانیهٔ اخیر + درخواست در جریان) اول؛ بار را پخش می‌کند          |
| `headroom`   | بیشترین ظرفیت باقی‌ماندهٔ context window بعد از این درخواست اول                    |

- **PeakEWMA**: میانگین نمایی تأخیر (α = ۰٫۲) در کنار «قله»ای که با هر نمونهٔ کند فوراً بالا می‌رود و با ثابت زمانی ۶۰ ثانیه افت می‌کند. یک provider که ناگهان کند شده، زودتر از میانگین ساده کنار می‌رود و بعد از بهبود آرام برمی‌گردد.
- **P2C** (power of two choices): در ترافیک واقعی برای `latency` دو هدف تصادفی انتخاب و سریع‌تر برنده می‌شود؛ بقیه به ترتیب امتیاز می‌آیند. این کار جلوی هجوم همهٔ درخواست‌ها به «سریع‌ترین» هدف را می‌گیرد. تست `packages/routing/src/sprint2.test.ts` نشان می‌دهد P2C از بین دو نمونه، هدفِ دارای دُم کند را رد می‌کند و p95 پایین می‌آید.
- مدلی که هنوز آماری ندارد در `latency` آخر قرار می‌گیرد (تا وقتی یک بار به‌عنوان فال‌بک امتحان شود).
- آمار در حافظهٔ هر replica است؛ ری‌استارت فقط یک دورهٔ گرم‌شدن کوتاه هزینه دارد و مسیریابی هرگز منتظر شبکه نمی‌ماند.

### Request hedging (۱۲.۲)

اگر پاسخ هدف اول تا `afterMs` نیامد، درخواست دوم به هدف بعدی هم فرستاده می‌شود و هر کدام زودتر جواب داد برنده است؛ دیگری لغو می‌شود. تنظیم در `hedging` هر combo:

| فیلد          | پیش‌فرض | توضیح                                                  |
| ------------- | ------- | ------------------------------------------------------ |
| `enabled`     | `false` | hedging فقط با فعال‌سازی صریح روشن می‌شود              |
| `afterMs`     | `800`   | مهلت پیش از شروع تلاش موازی                            |
| `maxParallel` | `2`     | حداکثر تلاش هم‌زمان (۲ تا ۴)                           |
| `maxRatio`    | `0.2`   | سهم درخواست‌هایی که اجازهٔ hedge دارند در پنجرهٔ زمانی |
| `windowMs`    | `60000` | طول پنجرهٔ بودجه                                       |

- **بودجه**: `HedgeBudget` یک پنجرهٔ لغزان است؛ تلاش موازی فقط وقتی شروع می‌شود که تعداد hedgeها از `maxRatio × درخواست‌ها` کمتر باشد. فال‌بک بعد از خطا مشمول این بودجه نیست.
- **هزینه**: تعداد تلاش‌های اضافه در `hedgeAttempts` رویداد مصرف و ستون `request_log.hedge_attempts` ثبت می‌شود و همهٔ تلاش‌ها در `attempts` می‌آیند. هزینهٔ ثبت‌شده، هزینهٔ تلاش برنده است؛ تلاش لغوشده مصرف توکن گزارش نمی‌کند، پس اگر provider برای آن صورت‌حساب بدهد در DiRouter دیده نمی‌شود. `hedgeAttempts` برای برآورد همین سربار است و `maxRatio` سقف آن را می‌بندد.
- در stream، بعد از رسیدن اولین بایت به کلاینت تلاش دیگری شروع نمی‌شود (committed).

### Health probe دوره‌ای (۱۲.۳)

گیت‌وی در هر دور، endpoint ارزان «فهرست مدل‌ها»ی هر credential فعال را صدا می‌زند (توکنی تولید نمی‌شود، پس برای providerهای مصرف‌محور هزینه‌ای ندارد).

| تنظیم (`settings.healthProbe`) | پیش‌فرض | توضیح                                                |
| ------------------------------ | ------- | ---------------------------------------------------- |
| `enabled`                      | `false` | خاموش به‌صورت پیش‌فرض                                |
| `intervalSeconds`              | `60`    | فاصلهٔ دورها (حداقل ۱۰)                              |
| `failureThreshold`             | `3`     | شکست احراز هویت پیاپی پیش از غیرفعال‌سازی credential |
| `successThreshold`             | `1`     | موفقیت پیاپی پیش از بازگرداندن credential            |
| `maxPerRound`                  | `50`    | سقف credentialهای بررسی‌شده در هر دور (پنجرهٔ چرخشی) |

- فقط خطای کلاس `auth` یک credential را غیرفعال می‌کند. قطعی provider (5xx، timeout، اتصال) کار circuit breaker است؛ غیرفعال کردن همهٔ کلیدها در قطعی، علت واقعی را پنهان می‌کرد.
- credential غیرفعال (چه با probe و چه با خطای ترافیک واقعی) به محض موفقیت probe خودکار برمی‌گردد و تغییر به همهٔ replicaها منتشر می‌شود.
- با Valkey فقط یک replica در هر دور probe می‌کند (قفل `dirouter:health:probe-lock`)، پس upstream به ازای هر credential یک درخواست می‌بیند.
- فهرست مدل حتی وقتی حساب اعتبار ندارد پاسخ می‌دهد؛ تست زمان‌بندی‌شدهٔ کانال به‌جای آن یک درخواست واقعی یک‌توکنی می‌فرستد ([upstream-balances.fa.md](../upstream-balances.fa.md)، کارت ۳۲.۹).
- **تاریخچهٔ uptime**: نمونه‌ها در لیست `dirouter:health:samples` صف می‌شوند و job `health-samples` در worker هر ۳۰ ثانیه آن‌ها را به جدول `provider_health_samples` می‌برد (نگه‌داری: `HEALTH_SAMPLE_RETENTION_DAYS`، پیش‌فرض ۳۰ روز). خواندن: `GET /orgs/:orgId/health/uptime?from=&to=` با درصد uptime، میانگین تأخیر و سطل‌های ساعتی برای هر provider.

### Session affinity (۱۲.۴)

برای comboهای `sticky: true` یک نشست تا پایان TTL روی همان مدل و credential می‌ماند (تا وقتی سالم باشد). فایده: prompt cache سمت provider برای گفت‌وگوهای طولانی (مثل Claude Code) هر بار hit می‌شود.

| تنظیم (`settings.sessionAffinity`) | پیش‌فرض              |
| ---------------------------------- | -------------------- |
| `enabled`                          | `false`              |
| `header`                           | `x-dirouter-session` |
| `ttlSeconds`                       | `3600`               |

شناسهٔ نشست به این ترتیب تعیین می‌شود:

1. مقدار هدر تنظیم‌شده (حداکثر ۲۰۰ نویسه)، همراه با شناسهٔ کلید؛ دو کلید هرگز یک نشست مشترک ندارند.
2. بدون هدر: هش SHA-256 پیشوند پایدار گفت‌وگو (system prompt + اولین پیام). ابزارهای agent این بخش را در هر نوبت بدون تغییر می‌فرستند، و این همان چیزی است که cache provider روی آن کلید می‌خورد. درخواست تک‌پیامِ بدون system prompt سنجاق نمی‌شود.

اگر هدف سنجاق‌شده ناسالم شود (breaker، cooldown)، درخواست طبق استراتژی عادی جلو می‌رود و نشست روی هدف موفق جدید سنجاق می‌شود. متن prompt هرگز در شناسه یا لاگ نمی‌آید.

### شبیه‌ساز مسیریابی (۱۲.۵)

`POST /orgs/:orgId/routes/simulate` (مجوز `models:read`) همان resolver ترافیک واقعی را بدون I/O اجرا می‌کند:

```json
{
  "model": "smart",
  "virtualKeyId": "key_…",
  "estimatedInputTokens": 120000,
  "maxOutputTokens": 4096
}
```

پاسخ شامل `candidates` (به ترتیب تلاش، با provider و credential) و `skipped` (هر هدف کنارگذاشته با دلیل: `model_disabled`، `provider_disabled`، `context_window`، `provider_circuit_open`، `model_circuit_open`، `credential_disabled`، `credential_cooldown`) است. خطاهای مسیریابی (`model_not_found`، `model_not_allowed`، `no_available_provider`، `context_length_exceeded`) هم نتیجهٔ معتبر شبیه‌سازی‌اند و با `ok: false` برمی‌گردند. در داشبورد: صفحهٔ «شبیه‌ساز مسیریابی».

هر candidate یک `signals` هم دارد که ورودی‌های زندهٔ استراتژی‌های پویاست (کارت 25.4): `latencyMs` (PeakEWMA؛ تا وقتی مدل ترافیک نداشته باشد نیست)، `costMicroUsd` (قیمت تخمینی درخواست شبیه‌سازی‌شده)، `recentRequests` و `inFlight`، و `headroomTokens` (وقتی پنجرهٔ زمینهٔ مدل تعیین نشده نیست). صفحهٔ شبیه‌ساز همان سیگنالی را نشان می‌دهد که استراتژی ترکیب بر اساس آن مرتب کرده است.

### تنظیمات سراسری گیت‌وی

تنظیم‌های `healthProbe`، `sessionAffinity`، `cache`، `compression`، `tracing` و `breaker` در یک ردیف جدول `gateway_settings` ذخیره و در `ConfigSnapshot.settings` به همهٔ replicaها می‌رسند:

```bash
curl -X PUT "$ADMIN/orgs/$ORG/config/settings" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"healthProbe":{"enabled":true,"intervalSeconds":60},"sessionAffinity":{"enabled":true}}'
```

کل شیء پیش از ذخیره اعتبارسنجی می‌شود؛ ورودی نامعتبر هیچ تغییری ایجاد نمی‌کند. `GET` همان مسیر، مقدار ذخیره‌شده و مقدار مؤثر (با پیش‌فرض‌ها) را برمی‌گرداند.

</div>
