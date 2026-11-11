[English](providers.md) · [فارسی](providers.fa.md)

<div dir="rtl">

# مدیریت provider و credential

کد: `apps/control-api/src/providers` و `apps/gateway/src/probe.ts` · کارت ۳.۶

## endpointها (`/api/v1/orgs/:orgId/providers`)

| مسیر                           | مجوز              | توضیح                                                                                                                                          |
| ------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`، `GET /:id`            | `providers:read`  | فهرست و جزئیات؛ credentialها **ماسک‌شده**                                                                                                      |
| `POST /`                       | `providers:write` | `{name, type, baseUrl?, slug?, proxyUrl?, timeouts?, options?, maxConcurrency?, credentials?: [{name, secret, weight?, headers?, proxyUrl?}]}` |
| `PATCH /:id`، `DELETE /:id`    | `providers:write` | ویرایش؛ حذف soft است و provider را غیرفعال می‌کند                                                                                              |
| `POST /:id/credentials`        | `providers:write` | افزودن کلید                                                                                                                                    |
| `PATCH /:id/credentials/:cid`  | `providers:write` | تغییر نام، وزن، هدر یا پروکسی، `status: ACTIVE/DISABLED`، یا **چرخش** با `secret` تازه                                                         |
| `DELETE /:id/credentials/:cid` | `providers:write` | حذف کلید                                                                                                                                       |
| `POST /:id/test`               | `providers:write` | `{credentialId?}` → `{ok, status, latencyMs, error?, modelCount}`                                                                              |
| `POST /:id/discover`           | `providers:write` | مدل‌های upstream با `inCatalog` و `suggested`، به‌علاوهٔ قیمت و context از کاتالوگ اگر شناخته‌شده باشد                                         |

نوع‌ها: `openai`، `anthropic`، `gemini`، `azure-openai` و `openai-compatible` (با `options.preset` مثل groq یا openrouter؛ [providers/](../providers/README.fa.md)). baseUrl برای openai، anthropic و gemini پیش‌فرض دارد. برای Azure و سازگارها لازم است.

## secret

- secret فقط یک بار وارد می‌شود. با **AES-256-GCM** و `MASTER_KEY` رمز می‌شود و AAD شناسهٔ credential است. قالب ذخیره `v<keyVersion>.<base64url>` است و `key_version` جدا نگه داشته می‌شود تا کلید اصلی بچرخد.
- پاسخ API فقط `••••last4` را نشان می‌دهد. از هدرها فقط نام‌ها می‌آیند. رمز پروکسی ماسک می‌شود (`socks5h://user:***@…`).
- در audit log، مقدار `secret` با `[REDACTED]` جایگزین و رمز پروکسی ماسک می‌شود.
- control-api هیچ‌وقت secret را باز نمی‌کند. برای تست و کشف، ciphertext به گیت‌وی می‌رود و فقط در حافظهٔ گیت‌وی باز می‌شود.

## تست اتصال و کشف مدل

```
control-api ──POST /internal/providers/probe (Bearer INTERNAL_TOKEN، provider با secret رمزشده)──▶ gateway
gateway: decrypt → adapter.listModelsRequest → همان پروکسی (credential، provider یا سراسری) و timeout ترافیک واقعی → GET /models
```

- نتیجه شامل `ok`، `status` و `latencyMs` است. در خطا، کلاس آن (`auth`، `connection`، `timeout`، …) و پیام کوتاه می‌آید، با رمز پروکسی ماسک‌شده.
- **کشف**: هر مدل upstream با مدل‌های همین provider در کاتالوگ سازمان (جدول `models`) مقایسه می‌شود. مدل‌های تازه `suggested: true` می‌گیرند. اگر مدل در کاتالوگ قیمت (`packages/model-catalog`) شناخته‌شده باشد، `catalog.key`، `contextWindow` و قیمت هم می‌آید تا داشبورد با یک کلیک اضافه‌اش کند (کارت ۳.۸).
- `/internal/providers/probe` بدون توکن داخلی 404 می‌دهد، حتی از Traefik.
- آدرس گیت‌وی: `GATEWAY_INTERNAL_URL` (پیش‌فرض `http://gateway:8080`). با چند replica، DNS بین آن‌ها پخش می‌کند.

## بررسی (۲۰۲۶-۱۱-۰۷)

- تست integration در control-api (۷ مورد، روی Postgres و Valkey واقعی با گیت‌وی ساختگی که درخواست را ضبط می‌کند):
  - secret در هیچ پاسخی نیست و در DB فقط ciphertext است.
  - چرخش، غیرفعال‌سازی و حذف کلید.
  - به گیت‌وی فقط ciphertext می‌رسد.
  - تست اتصال latency برمی‌گرداند و کشف مدل‌های تازه را پیشنهاد می‌دهد.
  - VIEWER پاسخ 403 و سازمان دیگر 404 می‌گیرد.
  - **هیچ خطی از لاگ و هیچ رکورد audit secret را ندارد.**
- تست گیت‌وی روی mock-provider واقعی: فهرست مدل و latency برای OpenAI-compatible و Anthropic، کلید اشتباه (کلاس `auth`، 401)، و پروکسی مرده (کلاس `connection`، رمز ماسک‌شده).
- compose از Traefik:
  - provider به mock ساخته شد و `••••4242` نشان داده شد.
  - test پاسخ `{ok:true, status:200, latencyMs:8, modelCount:3}` داد و discover سه مدل پیشنهادی برگرداند.
  - در لاگ همهٔ کانتینرها، تعداد خط‌هایی که secret را داشتند صفر بود.

</div>
