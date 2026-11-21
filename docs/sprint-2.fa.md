[English](sprint-2.md) · [فارسی](sprint-2.fa.md)

<div dir="rtl">

# راهنمای قابلیت‌های اسپرینت ۲ (v1)

> تاب‌آوری پیشرفته، APIها و providerهای بیشتر، کش، امنیت سازمانی، guardrail، هشدار، تحلیل مصرف، پیکربندی نسخه‌دار و HA. همهٔ قابلیت‌های زیر **به‌صورت پیش‌فرض خاموش‌اند** مگر خلافش گفته شده باشد؛ پس به‌روزرسانی رفتار نصب موجود را تغییر نمی‌دهد.

## مستندات هر قابلیت

| حوزه               | قابلیت (کارت)                                                                                                                                              | راهنما                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| APIها و providerها | ورودی Gemini API (۱۱.۱)                                                                                                                                    | [gateway/gemini-inbound.fa.md](gateway/gemini-inbound.fa.md)                                               |
|                    | OpenAI Responses API و `previous_response_id` (۱۱.۲)                                                                                                       | [gateway/responses.fa.md](gateway/responses.fa.md)، [gateway/translation.fa.md](gateway/translation.fa.md) |
|                    | Bedrock، Vertex، Cohere، Mistral، Voyage، Jina (۱۱.۳)                                                                                                      | [providers/README.fa.md](providers/README.fa.md)                                                           |
|                    | `/v1/embeddings`، شامل انتقال base64 در SDK (۱۱.۴)                                                                                                         | [gateway/embeddings.fa.md](gateway/embeddings.fa.md)                                                       |
| مسیریابی           | `latency`، `cost`، `least-used`، `headroom`، PeakEWMA و P2C (۱۲.۱)؛ hedging (۱۲.۲)؛ health probe و uptime (۱۲.۳)؛ session affinity (۱۲.۴)؛ شبیه‌ساز (۱۲.۵) | [concepts/routing.fa.md](concepts/routing.fa.md)                                                           |
| کش و صرفه‌جویی     | Exact cache با replay در stream (۱۳.۱)؛ semantic cache به ازای پروژه (۱۳.۲)؛ فشرده‌سازی کانتکست (۱۳.۳)                                                     | [concepts/caching.fa.md](concepts/caching.fa.md)                                                           |
| امنیت              | MFA و MFA اجباری بر اساس نقش (۱۴.۱)؛ نقش سفارشی (۱۴.۳)؛ لاگ ممیزی (۱۴.۴)؛ چرخش `MASTER_KEY` (۱۴.۵)                                                         | [security.fa.md](security.fa.md)                                                                           |
|                    | SSO با OIDC و Keycloak محلی (۱۴.۲)                                                                                                                         | [sso.fa.md](sso.fa.md)                                                                                     |
| Guardrail          | موتور، redact در stream، اعتبارسنجی PII (۱۵.۱)؛ صفحهٔ سیاست با تست زنده (۱۵.۲)                                                                             | [concepts/guardrails.fa.md](concepts/guardrails.fa.md)                                                     |
| داشبورد            | هزینه و بودجه (۱۶.۱)، نمای زنده (۱۶.۳)، تحلیل مصرف (۱۶.۴)، playground (۱۶.۵)، امنیت، تنظیمات                                                               | [dashboard/sprint2-pages.fa.md](dashboard/sprint2-pages.fa.md)                                             |
| هشدار              | قانون‌ها، کانال‌ها، پیام آزمایشی (۱۶.۲)                                                                                                                    | [alerts.fa.md](alerts.fa.md)                                                                               |
| پیکربندی           | تنظیمات سراسری گیت‌وی، نسخه‌ها، diff، rollback، خروجی و ورودی (۱۷.۱)                                                                                       | [control-api/config-sync.fa.md](control-api/config-sync.fa.md)                                             |
| مشاهده‌پذیری       | رهگیری OpenTelemetry با انتشار W3C (۱۷.۲)                                                                                                                  | [observability.fa.md](observability.fa.md)                                                                 |
| استقرار            | Valkey Sentinel، standby برای PostgreSQL، replicaها، بکاپ و تمرین بازیابی (۱۷.۳)                                                                           | [deploy-ha.fa.md](deploy-ha.fa.md)                                                                         |
| تست                | تست chaos (۱۸.۱)                                                                                                                                           | [benchmarks/chaos.fa.md](benchmarks/chaos.fa.md)                                                           |

## روشن کردن قابلیت‌ها

بیشتر قابلیت‌های زمان اجرا با یک سند JSON کنترل می‌شوند: تنظیمات گیت‌وی، که در صفحهٔ **تنظیمات و نسخه‌ها** یا با `PUT /orgs/:orgId/config/settings` ویرایش می‌شود. این سند یکجا اعتبارسنجی، در `gateway_settings` ذخیره و به‌صورت نسخهٔ جدید config برای همهٔ replicaهای گیت‌وی منتشر می‌شود.

```json
{
  "cache": {
    "exact": { "enabled": true, "ttlSeconds": 300 },
    "semantic": {
      "enabled": false,
      "projects": { "prj_support": { "enabled": true, "threshold": 0.92 } }
    }
  },
  "compression": { "enabled": true, "maxToolResultChars": 2000, "keepRecentMessages": 4 },
  "sessionAffinity": { "enabled": true },
  "healthProbe": { "enabled": true, "intervalSeconds": 60 },
  "tracing": {
    "enabled": true,
    "endpoint": "http://otel-collector:4318/v1/traces",
    "sampleRatio": 0.1
  }
}
```

قابلیت‌های هر combo (`strategy`، `hedging`، `sticky`) روی خود combo تنظیم می‌شوند؛ guardrail، هشدار، SSO، نقش سفارشی و سیاست MFA صفحهٔ خودشان را دارند.

**semantic cache** فقط با این تنظیم روشن نمی‌شود: یک image از PostgreSQL با افزونهٔ pgvector لازم دارد (`deploy/docker/postgres.Dockerfile` را بسازید و `POSTGRES_IMAGE` را تنظیم کنید؛ image پیش‌فرض `postgres:17-alpine` این افزونه را ندارد) و همین‌طور `SEMANTIC_CACHE_EMBEDDING_URL`. جدول کش به‌محض در دسترس بودن افزونه خودکار ساخته می‌شود. جزئیات در [concepts/caching.fa.md](concepts/caching.fa.md).

## به‌روزرسانی از اسپرینت ۱

1. migrationها را اعمال کنید (`make migrate`): `20261111000000_sprint2` و `20261120000000_gateway_settings` (جدول تنظیمات گیت‌وی، ستون‌های دامنهٔ semantic cache، نسخه‌های سنجاق‌شدهٔ config). هر دو فقط اضافه می‌کنند.
2. Prisma client و کلاینت API تولیدشدهٔ داشبورد را دوباره تولید و ایمیج‌ها را دوباره بسازید.
3. متغیرهای محیطی اختیاری جدید در [env-reference.fa.md](env-reference.fa.md) آمده‌اند: `SEMANTIC_CACHE_EMBEDDING_*`، `POSTGRES_IMAGE`، `HEALTH_SAMPLE_RETENTION_DAYS`، `ALERT_EVALUATE_INTERVAL_MS` و برای overlay مربوط به HA، `REPLICATION_PASSWORD`، `POSTGRES_HOST`، `HA_IP_PREFIX` و تعداد replicaها. `VALKEY_URL` حالا آدرس Sentinel هم می‌پذیرد.
4. لازم نیست چیزی فعال شود؛ کلیدها، comboها و providerهای موجود مثل قبل کار می‌کنند.

تغییر رفتارهایی که باید بدانید:

- `/v1/embeddings` حالا `encoding_format: "base64"` را می‌پذیرد (قبلاً ۴۲۲ می‌داد)؛ همان چیزی که SDKهای رسمی OpenAI پیش‌فرض می‌فرستند.
- کلید exact cache حالا شناسهٔ پروژه را هم دارد: ورودی‌های نوشته‌شده پیش از به‌روزرسانی دوباره استفاده نمی‌شوند.
- فشرده‌سازی کانتکست دیگر هیچ پیامی را حذف نمی‌کند؛ به‌جایش خروجی ابزار را کوتاه و تکرار را حذف می‌کند.
- ورودی‌های semantic cache به پروژه و مدل امبدینگ محدود شده‌اند؛ ورودی‌های قبل از به‌روزرسانی دیگر تطبیق نمی‌خورند و منقضی می‌شوند.

## چه چیزی تأیید شده و چه چیزی نه

وضعیت در 2026-11-20 (working tree اسپرینت ۲، یک میزبان Docker: macOS Docker Desktop، ۴ CPU و ۴ گیگابایت حافظه).

### تأییدشده

- **بررسی‌های خودکار** به‌صورت محلی سبزند: typecheck، ESLint، Prettier، تست‌های واحد و مجموعهٔ integration روی کانتینرهای موقت PostgreSQL 17 و Valkey 8.
- **End-to-end** روی stack توسعهٔ Compose و از طریق Traefik: `node scripts/e2e/sprint-2.mjs` تعداد ۲۲ سناریو را اجرا می‌کند، یکی برای هر قابلیت:

  | کارت | سناریو                                                                                               |
  | ---- | ---------------------------------------------------------------------------------------------------- |
  | ۱۱.۱ | ورودی Gemini، شامل tool call در stream                                                               |
  | ۱۱.۲ | Responses API با درخواستی به شکل Codex: رویدادهای نوع‌دار stream، tool call و `previous_response_id` |
  | ۱۱.۴ | Embeddings، شامل اندازه‌گیری مصرف                                                                    |
  | ۱۲.۴ | Session affinity                                                                                     |
  | ۱۲.۵ | شبیه‌ساز مسیریابی                                                                                    |
  | ۱۳.۱ | Exact cache                                                                                          |
  | ۱۳.۲ | Semantic cache روی pgvector                                                                          |
  | ۱۳.۳ | فشرده‌سازی                                                                                           |
  | ۱۴.۱ | MFA                                                                                                  |
  | ۱۴.۲ | SSO با Keycloak (`compose.sso.yaml`)                                                                 |
  | ۱۴.۳ | نقش سفارشی                                                                                           |
  | ۱۴.۴ | لاگ ممیزی                                                                                            |
  | ۱۴.۵ | چرخش `MASTER_KEY` زیر بار                                                                            |
  | ۱۵.۱ | موتور guardrail                                                                                      |
  | ۱۵.۲ | سیاست‌های guardrail                                                                                  |
  | ۱۶.۱ | هزینه در برابر دفتر مصرف                                                                             |
  | ۱۶.۲ | هشدار                                                                                                |
  | ۱۶.۳ | نمای زنده                                                                                            |
  | ۱۶.۴ | تحلیل مصرف                                                                                           |
  | ۱۶.۵ | Playground                                                                                           |
  | ۱۷.۱ | پیکربندی نسخه‌دار                                                                                    |
  | ۱۷.۲ | رهگیری (tracing)                                                                                     |

- **اندازه‌گیری‌شده در همان اجرا:**
  - چرخش `MASTER_KEY` تعداد ۱۸ secret (۱۶ credential و ۲ secret از نوع TOTP) را از نسخهٔ کلید ۱ به ۲ دوباره رمز کرد، در حالی که هر ۱٬۲۷۸ درخواست همزمان موفق بودند.
  - rollback پیکربندی در حدود ۴۰ میلی‌ثانیه به گیت‌وی رسید (یک replica گیت‌وی).
  - هر درخواست حدود ۶۰۰ میلی‌ثانیه بعد از پایانش در نمای زنده دیده شد (۵ نمونه، ۵۹۲ تا ۶۲۸ میلی‌ثانیه).
  - جمع صفحهٔ هزینه برای ۱۲ درخواست روی یک کلید اختصاصی با دفتر مصرف برابر بود.
  - یک قانون هشدار در پنجرهٔ سکوتش دقیقاً یک بار فعال شد و webhook امضای HMAC معتبر داشت.
- **HA و chaos:** لایهٔ دادهٔ overlay مربوط به HA راه‌اندازی و تمرین شد (failover در Valkey، ارتقای PostgreSQL، تمرین بازیابی، base backup و آرشیو WAL)؛ جدول‌های ثبت تمرین در [deploy-ha.fa.md](deploy-ha.fa.md#ثبت-تمرینها) را ببینید. شش سناریوی chaos روی stack توسعه قبول شد؛ [benchmarks/chaos.fa.md](benchmarks/chaos.fa.md#نتایج) را ببینید.

### تأییدنشده

- **نشست واقعی با Gemini CLI و Codex CLI.** فقط درخواست‌هایی در سطح پروتکل و به شکل همین کلاینت‌ها فرستاده شده، آن هم به mock provider.
- **نرخ hit در prompt cache سمت provider** با Claude Code و یک provider واقعی.
- **Bedrock، Vertex، Cohere، Voyage و Jina در برابر سرویس واقعی.** فقط تست واحد با fixtureهای ضبط‌شده یا دست‌نویس دارند. SigV4 و decoder مربوط به event stream در AWS با frameهای دست‌ساز آزموده شده‌اند، نه با AWS واقعی. نسخهٔ پیش‌فرض API در Vertex برابر `v1beta1` است و در برابر Vertex واقعی تأیید نشده است.
- **لایهٔ برنامه در HA** (replicaهای گیت‌وی، control-api و worker پشت Traefik) و **سناریوی `gateway-replica` در تست chaos**.
- **بازیابی نقطه‌ای (PITR).**
- **صفحه‌های داشبورد در مرورگر واقعی**، از جمله جریان passkey (WebAuthn). قراردادهای API را اجرای end-to-end پوشش می‌دهد؛ رفتار UI فقط با تست واحد پوشش داده شده است.

### محدودیت‌های شناخته‌شده

- نوع‌های قانون هشدار `breaker_open` و `queue_length` را API رد می‌کند؛ worker آن‌ها را پیاده‌سازی نکرده است.
- ابزارهای `custom` (آزادمتن) در Codex مثل `apply_patch` در مترجم Responses حذف می‌شوند.
- هویت‌های SSO با ایمیل تأییدشده در سازمانِ همان connection تطبیق داده می‌شوند و هنوز به `(connection, sub)` مقید نشده‌اند.
- connectionهای SSO را فقط مالک سازمان می‌تواند مدیریت کند.
- semantic cache یک image از PostgreSQL با pgvector (`POSTGRES_IMAGE` و `deploy/docker/postgres.Dockerfile`) و `SEMANTIC_CACHE_EMBEDDING_URL` لازم دارد.
- `GET config/versions` متادیتای نسخه‌ها را در سطح کل instance فهرست می‌کند.

پیش از انتشار، `./scripts/verify/run.sh` را اجرا کنید (نصب، generate، typecheck، lint، واحد، compose، migrate، integration، e2e) و بعد `CHAOS=1 ./scripts/verify/run.sh`، و نتیجهٔ chaos و تمرین‌های HA را به صفحه‌های خودشان اضافه کنید.

</div>
