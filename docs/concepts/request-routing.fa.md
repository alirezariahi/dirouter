[English](request-routing.md) · [فارسی](request-routing.fa.md)

<div dir="rtl">

# مسیریابی در سطح درخواست

> کد: `packages/routing/src/plan.ts`، `preferences.ts`، `policy.ts` و `apps/gateway/src/route-request.ts` (اسپرینت ۵).

هر درخواست می‌تواند خودش مسیریابی را هدایت کند، با همان قالبی که OpenRouter به کار می‌برد، و مدیر می‌تواند همین انتخاب‌ها را برای سازمان، پروژه یا کلید تعیین یا قفل کند. ترافیک واقعی و شبیه‌ساز مسیریابی یک برنامه‌ریز مشترک (`planRoute`) دارند، پس شبیه‌ساز همیشه همان کاری را نشان می‌دهد که درخواست انجام می‌دهد.

مرحله‌های برنامه‌ریزی به ترتیب:

۱. resolve مدل درخواستی و سپس هر مدل آرایهٔ فال‌بک `models` ([resolver](routing.fa.md) تغییری نکرده است).
۲. سیاست داده: منطقه، کشور، نگهداری صفر داده و استفاده برای آموزش (کارت ۳۲.۵).
۳. ترجیح ارائه‌دهنده (شیء `provider`): `only` و `ignore`، `max_price`، `sort` و در پایان `order` و `allow_fallbacks`.

هر کاندیدایی که در این مسیر کنار برود با دلیلش در `skipped` می‌آید.

## ترجیح ارائه‌دهنده (کارت ۳۲.۱)

<div dir="ltr">

```json
{
  "model": "chat",
  "models": ["openai/gpt-4.1-mini", "anthropic/claude-haiku-4-5"],
  "provider": {
    "order": ["openai", "azure-eu"],
    "only": ["openai", "azure-eu", "anthropic"],
    "ignore": ["deepinfra"],
    "allow_fallbacks": true,
    "sort": "price",
    "max_price": { "prompt": 1, "completion": 4 }
  },
  "messages": [{ "role": "user", "content": "Hi" }]
}
```

</div>

| فیلد              | اثر                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order`           | این ارائه‌دهنده‌ها اول و به همین ترتیب؛ بقیه پس از آن‌ها. بر `sort` مقدم است.                                                                                                             |
| `only`            | فقط این ارائه‌دهنده‌ها.                                                                                                                                                                   |
| `ignore`          | هرگز این ارائه‌دهنده‌ها.                                                                                                                                                                  |
| `allow_fallbacks` | `false`: هیچ ارائه‌دهنده‌ای بیرون از `order` (بدون `order`: فقط اولین ارائه‌دهنده). پیش‌فرض `true`.                                                                                       |
| `sort`            | `price` (قیمت برآوردی همین درخواست)، `throughput` (توکن خروجی در ثانیه، زنده) یا `latency` (تأخیر اخیر، زنده). شکل `{"by": "price"}` هم پذیرفته می‌شود.                                   |
| `max_price`       | بیشترین قیمت به دلار برای هر میلیون توکن (`prompt`، `completion`)، هر درخواست (`request`) یا هر تصویر (`image`). با مبلغی مقایسه می‌شود که مشتری می‌پردازد (قیمت فروش و ضریب گروه مشتری). |
| `models`          | حداکثر ۸ مدل فال‌بک که به ترتیب پس از `model` امتحان می‌شوند. مدلی که وجود ندارد یا کلید اجازه‌اش را ندارد کنار می‌رود و گزارش می‌شود.                                                    |

ارائه‌دهنده با slug، نوع (`openai`، `anthropic` و …) یا نام نمایشی‌اش نامیده می‌شود و بزرگی و کوچکی حروف مهم نیست. فیلدهایی که DiRouter به کار نمی‌برد (`require_parameters`، `quantizations`، `data_collection` و …) پذیرفته و نادیده گرفته می‌شوند و `provider`، `models` و `route` هرگز به ارائه‌دهنده فرستاده نمی‌شوند؛ پس کلاینتی که برای OpenRouter نوشته شده بدون تغییر کار می‌کند.

اگر پس از اعمال ترجیح‌ها کاندیدایی نماند، درخواست با **400 `no_provider_matches_preferences`** رد می‌شود و پیام، دلیل‌ها را می‌شمارد (مثلاً `above_max_price_prompt ×3`). شیء `provider` یا آرایهٔ `models` نامعتبر خطای 400 `invalid_request` می‌دهد.

دلیل‌های کنار گذاشتن در این مرحله: `provider_not_in_only`، `provider_ignored`، `above_max_price_prompt` / `_completion` / `_request` / `_image`، `fallbacks_not_allowed` و برای مدل‌های فال‌بک `fallback_model_not_found`، `fallback_model_not_allowed`، `fallback_no_available_provider` و `fallback_context_length_exceeded`.

### سرعت زنده

هر نمونهٔ گیت‌وی پس از هر درخواست موفق سرعت تولید هر مدل را می‌سنجد (توکن خروجی تقسیم بر زمان تولید، و برای stream پس از اولین توکن) و به صورت EWMA نگه می‌دارد. هر مدل به یک ارائه‌دهنده تعلق دارد، پس این عدد سرعت همان مدل روی همان ارائه‌دهنده است. شبیه‌ساز آن را برای هر کاندیدا در `signals.throughputTps` نشان می‌دهد و `sort: "throughput"` بر اساس آن مرتب می‌کند؛ مدل‌های بدون اندازه‌گیری آخر می‌آیند.

### سیاست مسیریابی و قفل مدیر

`PUT /orgs/:orgId/routing-policies` (مجوز `config:write`، یعنی فقط مالک و مدیر) سیاست یک حوزه را تعیین می‌کند و `GET` فهرست آن‌ها را می‌دهد (`config:read`). `policy: null` سیاست را حذف می‌کند.

<div dir="ltr">

```bash
curl -X PUT "$ADMIN/orgs/$ORG/routing-policies" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"scope":"key","scopeId":"key_…","policy":{"provider":{"order":["azure-eu"],"max_price":{"prompt":2}},"lockProvider":true}}'
```

</div>

- `provider`: ترجیح‌های پیش‌فرض (camelCase: `order`، `only`، `ignore`، `allowFallbacks`، `sort`، `maxPrice`). سیاست سازمان، پروژه و کلید با هم ترکیب می‌شوند و حوزهٔ دقیق‌تر هر فیلد حوزهٔ کلی‌تر را بازنویسی می‌کند.
- `lockProvider: true` در هر یک از سه حوزه: شیء `provider` و آرایهٔ `models` مشتری نادیده گرفته می‌شود و پاسخ header `x-dirouter-preferences: locked` دارد. بدون قفل، فیلدهای مشتری فیلد به فیلد جای فیلدهای مدیر را می‌گیرند.

سیاست‌ها در snapshot پیکربندی (`routingPolicies`) به گیت‌وی می‌رسند و هر تغییر در لاگ ممیزی (`routing_policy.updated`) ثبت می‌شود.

### شبیه‌ساز

`POST /orgs/:orgId/routes/simulate` فیلدهای `provider` (به همان شکل درخواست) و `models` را می‌پذیرد. پاسخ این‌ها را هم دارد: `models` (نام مدل‌هایی که کاندیداها از آن‌ها آمده‌اند)، `preferences` (آنچه اعمال شد)، `policy` (`lockProvider` و حوزه‌هایی که اعمال شدند) و `clientPreferencesIgnored`. شبیه‌ساز داشبورد برای هر دو فیلد دارد.

## سیاست داده و منطقه (کارت ۳۲.۵)

هر ارائه‌دهنده می‌تواند بگوید کجا اجرا می‌شود و با دادهٔ درخواست چه می‌کند (فیلد `dataPolicy` در `POST`/`PATCH /orgs/:orgId/providers/:id`؛ `null` آن را پاک می‌کند):

<div dir="ltr">

```json
{ "dataPolicy": { "region": "eu", "country": "DE", "zdr": true, "trainsOnData": false } }
```

</div>

`region` کدی دلخواه با حروف کوچک است (`eu`، `us` و …)، `country` کد دوحرفی ISO 3166-1، `zdr` یعنی نگهداری صفر داده و `trainsOnData` یعنی ارائه‌دهنده ممکن است با داده‌ها مدل آموزش دهد. ارائه‌دهندهٔ بدون metadata هر شرطی را که اثبات نکرده رد می‌کند: ZDR ندارد، ممکن است آموزش دهد و در هیچ منطقه‌ای نیست.

شرط‌ها در سیاست مسیریابی سازمان، پروژه یا کلید تعریف می‌شوند (`PUT /orgs/:orgId/routing-policies`، بالاتر را ببینید):

<div dir="ltr">

```json
{
  "scope": "organization",
  "scopeId": "org_…",
  "policy": {
    "dataPolicy": {
      "requireZdr": true,
      "denyTraining": true,
      "allowedRegions": ["eu"],
      "allowedCountries": ["DE", "FR"]
    }
  }
}
```

</div>

سه حوزه و خود درخواست با هم به **سخت‌گیرانه‌ترین** سیاست تبدیل می‌شوند: فهرست مناطق و کشورها اشتراک گرفته می‌شود و `requireZdr` و `denyTraining` روی هم جمع می‌شوند. درخواست می‌تواند در شیء `provider` محدودیت اضافه کند ولی هرگز نمی‌تواند محدودیتی را بردارد، حتی وقتی ترجیح‌ها قفل نیستند:

| فیلد درخواست              | شرط                                                  |
| ------------------------- | ---------------------------------------------------- |
| `zdr: true`               | `requireZdr` (مقدار `false` چیزی را عوض نمی‌کند)     |
| `data_collection: "deny"` | `denyTraining` (مقدار `"allow"` چیزی را عوض نمی‌کند) |
| `regions: ["eu"]`         | `allowedRegions` (افزودهٔ DiRouter)                  |
| `countries: ["DE"]`       | `allowedCountries` (افزودهٔ DiRouter)                |

سیاست داده بلافاصله پس از resolve و پیش از ترجیح‌ها، فال‌بک و hedging اعمال می‌شود: ارائه‌دهندهٔ حذف‌شده اصلاً کاندیدا نیست، پس هیچ retry، مدل فال‌بک یا تلاش hedge به آن نمی‌رسد. این سیاست برای هر فراخوانی‌ای که دادهٔ مشتری را می‌برد برقرار است: chat، `/v1/messages`، `/v1/responses`، Gemini، embeddings، تصویر، صوت و فراخوانی‌های moderation و classifier در guardrailها.

کاندیدای حذف‌شده یکی از این دلیل‌ها را دارد: `not_zdr`، `may_train_on_data`، `region_not_allowed` یا `country_not_allowed`. اگر کاندیدایی نماند درخواست با **400 `no_provider_matches_data_policy`** رد می‌شود و گیت‌وی سیاست و هدف‌های حذف‌شده را در سطح `info` لاگ می‌کند.

پاسخ شبیه‌ساز `dataPolicy` مؤثر را دارد و هر ردیف لاگ درخواست یک `routeDecision` شامل سیاست داده و هدف‌های حذف‌شده نگه می‌دارد (ستون `request_log.route_decision`) که در جزئیات درخواست در Log Explorer نمایش داده می‌شود.

</div>
