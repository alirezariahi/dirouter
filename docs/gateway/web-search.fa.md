[English](web-search.md) · [فارسی](web-search.fa.md)

<div dir="rtl">

# جستجوی وب و web fetch (کارت ۳۰.۸)

گیت‌وی جستجوی وب و خواندن صفحه را به‌صورت سرویس ارائه می‌دهد، تا هر مدلی بتواند با اطلاعات به‌روز
کار کند و ابزارهای کدنویسی ابزار `web_search` خود را حتی وقتی مدل پشت آن‌ها Anthropic نیست داشته
باشند.

## backendها

| backend             | تنظیم با                                                     | توضیح                                                          |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| SearXNG (خودمیزبان) | `WEB_SEARCH_SEARXNG_URL`                                     | قالب `format=json` باید در نمونه روشن باشد (`search.formats`). |
| Brave Search        | `WEB_SEARCH_BRAVE_API_KEY` (برای تست `WEB_SEARCH_BRAVE_URL`) |                                                                |
| Tavily              | `WEB_SEARCH_TAVILY_API_KEY` (`WEB_SEARCH_TAVILY_URL`)        |                                                                |

backendها به ترتیب `settings.webSearch.order` امتحان می‌شوند (پیش‌فرض SearXNG، Brave، Tavily)؛
backendی که خطا بدهد یا در ۸ ثانیه پاسخ ندهد کار را به بعدی می‌سپارد. backend بدون تنظیم نادیده
گرفته می‌شود. [env-reference.fa.md](../env-reference.fa.md) را ببینید.

## تنظیمات

`settings.webSearch` در تنظیمات گیت‌وی (صفحهٔ Config):

| فیلد              | پیش‌فرض                        | معنا                                                             |
| ----------------- | ------------------------------ | ---------------------------------------------------------------- |
| `enabled`         | `true`                         | با `false` جستجو، fetch و حالت online خاموش می‌شوند.             |
| `order`           | `["searxng","brave","tavily"]` | ترتیب backendها برای فال‌بک.                                     |
| `maxResults`      | `5`                            | تعداد نتیجه در هر جستجو (حداکثر ۲۰).                             |
| `cacheTtlSeconds` | `3600`                         | جستجوی یکسان از کش (Valkey) پاسخ می‌گیرد؛ ۰ یعنی خاموش.          |
| `searchPriceUsd`  | `0.005`                        | قیمت هر جستجو.                                                   |
| `fetchPriceUsd`   | `0.001`                        | قیمت هر fetch.                                                   |
| `fetchMaxBytes`   | `2097152`                      | بزرگ‌ترین صفحهٔ خوانده‌شده؛ بقیه دور ریخته می‌شود (`truncated`). |
| `fetchTimeoutMs`  | `10000`                        | مهلت یک fetch، با redirectها.                                    |

## `POST /v1/search`

</div>

```bash
curl https://api.example.com/v1/search -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' -d '{ "query": "DiRouter release notes", "max_results": 3 }'
```

```json
{
  "object": "web_search",
  "query": "DiRouter release notes",
  "backend": "searxng",
  "cached": false,
  "results": [{ "title": "…", "url": "https://…", "snippet": "…", "published": "…" }],
  "usage": { "searches": 1, "cost_usd": "0.00500000" }
}
```

<div dir="rtl">

## `POST /v1/fetch`

</div>

```bash
curl https://api.example.com/v1/fetch -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' -d '{ "url": "https://example.com/post", "max_bytes": 65536 }'
```

<div dir="rtl">

پاسخ شامل `url` (بعد از redirectها)، `status`، `content_type`، `title`، `content` (متن خوانا: بدون
اسکریپت، استایل و تگ)، `bytes`، `truncated` و `usage` است.

- **SSRF**: در production نشانی و هر مقصد redirect باید عمومی باشد: نشانی‌های خصوصی، loopback،
  link-local و metadata هنگام اتصال رد می‌شوند (403)، پس نامی که بعداً به نشانی خصوصی resolve شود
  (DNS rebinding) هم گرفته می‌شود. این برای همهٔ سازمان‌ها، حتی سازمان پلتفرم، اعمال می‌شود، چون
  نشانی را فراخوان API داده است.
- فقط `http` و `https`، بدون credential در URL (400)؛ حداکثر پنج redirect.
- فقط نوع‌های متنی (HTML، متن ساده، JSON، XML)؛ بقیه 415.
- محدود در زمان (`fetchTimeoutMs`، 504) و حجم (`fetchMaxBytes` یا `max_bytes` کوچک‌تر).

## حالت online

درخواست چتی که جستجوی وب بخواهد، برای آخرین پیام کاربر نتیجهٔ جستجو می‌گیرد و پاسخ منبع‌ها را
همراه دارد:

- چت OpenAI: `"web_search_options": {}` (فیلد خود OpenAI؛ `search_context_size` با مقدار `low` یعنی
  ۳ نتیجه و `high` یعنی ۱۰) یا `"plugins": [{ "id": "web", "max_results": 3 }]` (فیلد OpenRouter).
  نتیجه‌ها به‌صورت یک پیام system با منبع‌های شماره‌دار به مدل داده می‌شوند و پاسخ annotationهای
  `url_citation` در `choices[].message.annotations` دارد. هدر `x-dirouter-web-search` نام backend را
  می‌دهد.
- پسوند مدل `:online` همین حالت است (کارت ۳۱.۵ hook زیر را صدا می‌زند).
- درخواست استریم، پس از کامل شدن پاسخ مدل به‌صورت استریم پاسخ داده می‌شود.

## Claude Code و ابزار سرور `web_search`

WebSearch در Claude Code ابزار سرور Anthropic را می‌فرستد (`{"type": "web_search_20250305", …}`).
اگر مدل درخواست را یک provider از نوع Anthropic سرویس دهد، ابزار بی‌تغییر به Anthropic می‌رود. برای
هر مدل دیگری گیت‌وی خودش آن را اجرا می‌کند:

۱. ابزار سرور به یک ابزار تابعی `web_search(query)` تبدیل می‌شود.
۲. هر بار که مدل آن را صدا بزند (تا `max_uses` ابزار، حداکثر ۱۰) گیت‌وی جستجو می‌کند و نتیجه را به
مدل می‌دهد.
۳. پاسخ همان بلوک‌هایی را دارد که API خود Anthropic برمی‌گرداند: `server_tool_use`،
`web_search_tool_result` (با آیتم‌های `web_search_result`: `title`، `url`، `page_age`) و متن مدل، به
همراه `usage.server_tool_use.web_search_requests`. استریم همین بلوک‌ها را به شکل رویدادهای Messages
API می‌گیرد.

## مصرف و هزینه

هر جستجو و هر fetch رویداد مصرف جدای خودش را دارد، با inbound API برابر `web.search` یا `web.fetch`،
مدل `web_search:<backend>` یا `web_fetch` و قیمت خودش، پس هزینهٔ جستجو در لاگ درخواست‌ها و گزارش
هزینه جدا دیده می‌شود. جستجویی که برای یک درخواست چت انجام شود شناسهٔ درخواست
`<chat request id>:web_search:<n>` دارد؛ فراخوانی‌های مدل همان شناسهٔ درخواست چت را نگه می‌دارند
(دورهای بعدی حلقهٔ جستجو `.r<n>` می‌گیرند). پاسخ از کش هزینه‌ای ندارد. جستجو و fetch از سقف نرخ و
بودجهٔ کلید کم می‌کنند و از کیف پول پیش‌پرداخت برداشت می‌شوند.

## hook برای پسوند `:online` (کارت ۳۱.۵)

</div>

```ts
// apps/gateway/src/web/service.ts, reachable as deps.web on ProxyDeps
deps.web?.serveOnline(api: 'openai.chat' | 'anthropic.messages', req: FastifyRequest, reply: FastifyReply): Promise<unknown>
```

<div dir="rtl">

`req.body` باید مدل را بدون پسوند داشته باشد. این متد کلید را احراز می‌کند، جستجو می‌کند، نتیجه‌ها
را تزریق می‌کند، مدل را از مسیر خود گیت‌وی صدا می‌زند و پاسخ (JSON یا SSE) را می‌فرستد.

## تست بدون اینترنت

mock provider هر سه backend و صفحه‌های آزمایشی را زیر `/web/…` سرو می‌کند
([mock-provider.fa.md](../mock-provider.fa.md))؛ Compose توسعه گیت‌وی را به آن‌ها وصل می‌کند.

</div>
