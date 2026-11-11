[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Dashboard user guide

This guide explains the current workflow of the Persian dashboard. The screenshots were taken on November 8, 2026 from a local development install with mock data; they contain no real credential or complete virtual key. Names and numbers in the images are samples, not production data.

## Getting started and orientation

- **Empty install:** open `/setup`. Step 1 creates the organization and the OWNER; step 2 optionally adds a provider with a credential; step 3 creates the `Default` project and the first virtual key. The password must be at least 10 characters. Copy the key right away and keep it safe; the full value cannot be recovered later.
- **Existing install:** `/login` asks for email and password. Sign out from the account menu. After a reload, the session is recovered from the refresh cookie, and it is revoked on sign-out or password change.
- The sidebar leads to Overview, Providers, Virtual keys, Models and Combos, Request logs, Health, Organization and the connection guides. The user account is available from the top bar and the `/account` path.
- The language (Persian/English), the calendar (Solar Hijri/Gregorian) and the theme (system/light/dark) can be changed. `⌘K` opens command search.
- The 24-hour / 7-day / 30-day range is shared between Overview and Keys. Overview pages refresh every 30 seconds, and health every 5 seconds.

![Dashboard sign-in](screenshots/login.png)

## Concepts: from provider to request

```text
Organization
├─ Provider ── Credential (several weighted upstream keys)
├─ Model ───── upstream name + price + context + capabilities
├─ Combo ───── several Models + strategy + retry/fallback
├─ Alias ───── stable client name → Model or Combo
└─ Project ─── Virtual Key ── allowed models + limit + budget + expiry/IP
```

| concept                     | meaning and practical note                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider**                | a connection to OpenAI, Anthropic, Gemini, Azure OpenAI or an OpenAI-compatible API. It has a base URL, proxy, timeouts and a concurrency cap.                                                                 |
| **Credential**              | the upstream secret inside a provider. Several weighted credentials are used for load/quota distribution and fallback. Only the last four characters are shown masked; the full value cannot be recovered.     |
| **Model**                   | a mapping of a public name to the provider's `upstreamModel`. It has a price per million tokens, context, max output and capabilities.                                                                         |
| **Combo**                   | a set of models. `priority` is a fixed order, `weighted` is weighted selection, and `round-robin` rotates per combo+key. `fallbackOn` determines which error class goes to the next candidate.                 |
| **Alias**                   | the name the client sees, pointing to a model or combo. When the alias target changes, the client's API name stays the same.                                                                                   |
| **Virtual Key**             | a `dr-…` key for the client app; it is different from a provider credential. Only the HMAC and the prefix are stored; the full value is shown once, on create or rotate.                                       |
| **RPM / TPM / Concurrency** | request/token caps per minute and concurrent requests. Key, project and team limits are applied together; a rejection is 429 with `Retry-After`.                                                               |
| **Budget**                  | a daily or monthly dollar or token cap. The period is in UTC. A started request finishes; after its cost is recorded, the next request may get 429 `budget_exceeded`.                                          |
| **Circuit breaker**         | after repeated health errors, a provider or model is temporarily `open`; `half_open` is limited testing, and `closed` is normal. Cooldown/lockout applies to a credential, not necessarily the whole provider. |

For details: [routing](../concepts/routing.md), [limits and budget](../concepts/limits.md), [keys](../control-api/keys.md).

## Overview — `/`

Compares the KPIs for requests, tokens, cost, error rate, p50/p95, TTFT and active keys with the previous period. Switch the chart between requests, cost and errors. Clicking a column or a row of an expensive model, key or project opens the Request Log with the same range and filter. The provider breaker status is summarized at the bottom of the page.

**Reading note:** cost is calculated from usage and the model price; a zero or outdated price makes the cost report wrong. "Closed" in a provider's status means the breaker is **closed** and normal, not disabled.

![Overview with KPIs, chart and top consumers](screenshots/overview.png)

## Providers — `/providers`

Writing is available to OWNER and ADMIN.

1. **Add a provider:** select a preset. For Azure or OpenAI-compatible providers, complete the Base URL. Enter a name and a credential; in the network settings, change the proxy, the four timeouts and the max concurrency only if needed.
2. **Test:** the provider card's test uses the default credential, and the row's test uses that same credential. The result shows latency, status and sometimes the number of models. Do not confuse 401/403 with network health.
3. **Discover models:** compares the upstream models with the organization's catalog. A known model is added with its catalog price; for an unknown model, enter the input/output price yourself.
4. **Credentials:** give each one a recognizable name and a weight. A custom header in the form `name: value` on each line, and an optional dedicated proxy, are allowed. After saving, only the masked secret and the header names are visible.
5. **Rotation / disabling:** to replace a secret, click **Rotate** and enter the new value; then test it. Disable is an immediate way to remove a credential from service. Deleting a provider is soft and disables it; deleting a model may be refused while it is in use.

**Check after a change:** the provider and the credential are active, the test passes, the model/alias exists, and a test request in the log reaches the intended provider. Seeing the breaker as closed alone does not prove the credential is correct.

![Provider and credential management with mock data](screenshots/providers.png)

## Virtual keys — `/keys`

The list can be filtered by name/prefix, project and status. The cost, count and tokens of each key in the current range are visible.

### Create

Choose a project and a name. An empty `allowedModels` means all models of the organization; to reduce access, enter model/alias/combo names separated by commas or new lines. RPM, TPM and max concurrency are optional. Set the expiry, the IP/CIDR allowlist and the daily/monthly budget according to the consumer.

### Safe rotation

1. Click **Rotate** and set the grace period for the old key (default 24 hours).
2. Put the new key, which is shown only once, in your secret manager, and move the clients to it.
3. The old key works until the grace period ends. After the migration, confirm with the logs/last-used time that it is no longer in use. If there is an active leak, do not wait for the grace period; **revoke** it immediately.

A `rotating` status means a replacement has been issued; `expired` and `revoked` keys cannot be used. MEMBER can also create keys; VIEWER can only view them.

![Virtual key list and limits](screenshots/keys.png)

## Models and Combos — `/models`

This page has three sections: model, alias and combo.

- **Model:** choose from the catalog to fill in the price, context and capabilities, or create a custom one. The `slug` is the name used in the API; `upstreamModel` is the provider's real name. Input and output prices are entered per million tokens, in USD. Editing a price manually detaches the model from the catalog sync; the catalog sync updates dependent models to the new version.
- **Combo:** add at least one and at most 20 unique models. Change the order by dragging or with the arrows. Retry means re-attempting a candidate, and fallback means moving to the next candidate; keep both limited. Before saving, the preview shows the priority/round-robin order or the weighted distribution.
- **Alias:** connect a stable name to a model or combo. The model/alias/combo namespace is shared, and a duplicate name is rejected.

`bad_request` and `content_filter` have no fallback. If part of a stream has already reached the client, no fallback is performed. The provider's final timeout takes priority over the combo's timeout setting.

![Model, alias and Combo management](screenshots/models.png)

## Request logs — `/logs`

The time, requested model, HTTP status/error code, total tokens, cost and latency are shown. Filters created from Overview appear as chips and as URL query parameters, so the link can be shared. Removing a chip clears that filter. The table loads the next page on scroll, and a "More" button also appears when a cursor exists.

- For troubleshooting, narrow the range and limit the model/key/project/status.
- This page shows metadata; it does not show the full prompt and response. Match the `X-Request-Id` of the gateway's response with the structured log of the gateway/worker.
- End-to-end latency is different from TTFT. Do not confuse a provider error with an admission error such as a rate limit or budget.
- If a new request does not appear, first wait a little and check the filters; then check the queue backlog and the worker according to the [Runbook](../runbook.md#۸-تأخیر-یا-افت-usage-و-لاگ-درخواست).

![Request logs with filters and cost](screenshots/logs.png)

## Health — `/health`

- **Nodes:** the replica ID, config version, ready state and last seen time. Very different versions, or a stale last-seen time, indicate a sync or heartbeat problem.
- **Providers:** the breaker, error count / total, and the next half-open time. Credentials show their cooldown, temporary disable or model lockout separately.
- **Models:** only models whose breaker is not closed are listed; the message "all closed" means the breaker state is normal.

OWNER and ADMIN can click reset. A reset **does not fix the cause**, and it does not restore a wrong credential or an exhausted quota. First fix the connection and the error, then reset if needed and send a test request. Resets are recorded in the audit log and announced to the reachable replicas.

![Health of nodes, providers and credentials](screenshots/health.png)

## Organization — `/organization`

- OWNER/ADMIN can change the organization name. If you have several memberships, the organization selection is on this page.
- Members are invited with the OWNER, ADMIN, MEMBER or VIEWER role. A pending invitation can be revoked. If SMTP is not configured, deliver the invitation link to the person securely; do not post it in a public channel.
- A team groups projects, and a project owns virtual keys and is the boundary for reports and limits. Do not delete a team or project before reviewing its dependencies.
- Removing a member or demoting an OWNER must be done with a replacement owner and an access review. Give regular users the minimum role they need.

| role   | main access                                                        |
| ------ | ------------------------------------------------------------------ |
| OWNER  | full management of the organization and roles                      |
| ADMIN  | management of providers/config and permitted members, health reset |
| MEMBER | create projects and keys, view, and permitted operational work     |
| VIEWER | view only; no write or reset buttons                               |

![Members, invitations, teams and projects](screenshots/organization.png)

## Connection guides — `/guides`

Claude Code, Codex, Cursor, Cline, Roo Code, Continue, Aider, the OpenAI Python/Node SDKs, the Anthropic SDK and curl are supported.

1. Choose the tool and the model/alias name.
2. Create a new key, or temporarily enter the full value of an existing key. Selecting a key name from the list does **not** recover its secret value.
3. Copy the snippet. After copying, the entered value is cleared from the page. The copied snippet contains the secret, so do not paste it into a public issue or chat.
4. The OpenAI endpoint is usually `<gateway>/v1`, and the Anthropic one is the gateway root. Change the model to your organization's real name; `gpt-4.1` is only a default/example.

![Tool connection guides](screenshots/guides.png)

## Account — `/account`

Enter your current password and a new password of at least 10 characters. After the change, all sessions are revoked and you are sent to the login page. Keep the password in a password manager; do not enter it into a screenshot or any other form.

![Account password change](screenshots/account.png)

## Common scenarios

### A) Subscription first, then cheap API

1. Create two separate providers, each with a healthy credential, for a subscription model and a cheap API; the test of both must succeed.
2. Register the matching model of each provider with the correct upstream name, context and price.
3. Create a combo: `priority`, with the subscription model at order 0 and the cheap API at order 1.
4. Set `fallbackOn` only for the errors where switching makes sense, usually `rate_limit`, `overloaded`, `server`, `timeout` and `connection`. For 401/403, first fix the credential, and do not rely on blind fallback.
5. Point a stable alias to the combo; the virtual key should allow only this alias.
6. Get a 200 from the healthy provider. Then, in a test environment, disable or break the primary and check that the response reaches the secondary, and that the header/attempt log proves it. Do not cause deliberate failures in production without authorization.

### B) Fallback between several credentials of one provider

1. Create two separate credentials with independent accounts/quotas and clear names; give them equal initial weights.
2. Register the model only once for the provider; the credentials become the candidates of the same model.
3. Create the virtual key and the combo/alias, and allow `rate_limit` in the fallback.
4. In testing, make the first credential return 429. Expect the other credential to be tried, and the first one to enter cooldown; a model-specific 429 may only be a lockout of that model.
5. Check Health and the logs. Several credentials on one shared account or quota do not create independent capacity.

### C) Migration without changing the model name in the client

Create a stable alias and restrict the key to it. First connect the alias to the current model; test the new model, and then change the alias target. Compare one test request, and the error rate and cost, before and after. From the client's point of view, a rollback is just reverting the alias target.

## Common errors

| observed                                       | meaning and first action                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 401 `invalid_api_key` / `api_key_expired`      | the full key is correct, not revoked or expired, and it goes to the same organization/environment. If in doubt, rotate it.             |
| 403 `model_not_allowed`                        | the model/alias name is not in the key's `allowedModels`; fix the restriction or send an allowed model.                                |
| 404 `model_not_found`                          | the model/alias/combo does not exist in the organization or the name is wrong; get the exact name from the Models page.                |
| 429 `rate_limited`                             | the RPM/TPM/concurrency of one of the scopes is full; respect `Retry-After` and fix the burst pattern.                                 |
| 429 `budget_exceeded`                          | the period cap has been reached; review the usage and, if needed, deliberately adjust the budget. Period counting is UTC.              |
| 503 `no_available_provider`                    | the provider/model/credential is disabled, the breaker is open, or there is a cooldown. Check Health, and test after fixing the cause. |
| 401/403 from upstream                          | check the upstream secret, access or quota. A closed breaker alone does not prove the secret is healthy.                               |
| Provider response with tool format not working | match the Base URL and the tool's wire protocol with the guide; check the alias name and the model's tools/streaming capability.       |

For infrastructure outages and secret leaks, use the [operational Runbook](../runbook.md).

---

<a id="persian"></a>

# راهنمای کاربر داشبورد

این راهنما مسیر فعلی داشبورد فارسی را توضیح می‌دهد. تصویرها در ۸ نوامبر ۲۰۲۶ از نصب توسعهٔ محلی با دادهٔ mock گرفته شده‌اند؛ هیچ credential واقعی یا کلید مجازی کاملی در آن‌ها نیست. نام‌ها و اعداد تصویر نمونه‌اند، نه دادهٔ production.

## شروع و جهت‌یابی

- **نصب خالی:** `/setup` را باز کنید. مرحلهٔ ۱ سازمان و OWNER می‌سازد؛ مرحلهٔ ۲ provider اختیاری با credential می‌گیرد؛ مرحلهٔ ۳ پروژهٔ `Default` و اولین کلید مجازی می‌سازد. رمز باید حداقل ۱۰ کاراکتر باشد. کلید را همان‌جا کپی و امن نگه دارید؛ بازیابی مقدار کامل ممکن نیست.
- **نصب موجود:** `/login` ایمیل و رمز می‌گیرد. خروج از منوی حساب انجام می‌شود. نشست پس از reload از refresh cookie بازیابی می‌شود و با خروج/تغییر رمز باطل می‌شود.
- نوار کناری به نمای کلی، Providerها، کلیدهای مجازی، مدل‌ها و Combo، لاگ درخواست‌ها، سلامت، سازمان و راهنمای اتصال می‌رود. حساب کاربر از نوار بالا و مسیر `/account` در دسترس است.
- زبان فارسی/English، تقویم شمسی/میلادی و تم سیستم/روشن/تیره قابل تغییر است. `⌘K` جست‌وجوی فرمان را باز می‌کند.
- بازهٔ ۲۴ ساعت/۷ روز/۳۰ روز در Overview و Keys مشترک است. صفحات overview هر ۳۰ ثانیه و health هر ۵ ثانیه تازه می‌شوند.

![ورود به داشبورد](screenshots/login.png)

## مفاهیم: از provider تا درخواست

```text
Organization
├─ Provider ── Credential (چند کلید upstream با وزن)
├─ Model ───── نام upstream + قیمت + context + قابلیت‌ها
├─ Combo ───── چند Model + استراتژی + retry/fallback
├─ Alias ───── نام پایدار کلاینت → Model یا Combo
└─ Project ─── Virtual Key ── مدلهای مجاز + limit + بودجه + انقضا/IP
```

| مفهوم                       | معنا و نکتهٔ عملی                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider**                | اتصال به OpenAI، Anthropic، Gemini، Azure OpenAI یا API سازگار با OpenAI. Base URL، proxy، timeout و سقف همزمانی دارد.                                                       |
| **Credential**              | راز upstream داخل provider. چند credential وزن‌دار برای توزیع بار/سهمیه و فال‌بک استفاده می‌شوند. فقط چهار حرف آخر ماسک‌شده دیده می‌شود؛ مقدار کامل قابل بازیابی نیست.       |
| **Model**                   | نگاشت نام عمومی به `upstreamModel` همان provider. قیمت بر یک میلیون توکن، context، max output و قابلیت‌ها را دارد.                                                           |
| **Combo**                   | مجموعهٔ مدلها. `priority` ترتیب ثابت، `weighted` انتخاب وزنی و `round-robin` چرخش به ازای combo+کلید دارد. `fallbackOn` تعیین می‌کند کدام کلاس خطا به کاندیدای بعدی برود.    |
| **Alias**                   | نامی که کلاینت می‌بیند و به model یا combo اشاره می‌کند. با تغییر مقصد alias، نام API کلاینت ثابت می‌ماند.                                                                   |
| **Virtual Key**             | کلید `dr-…` برای اپ کلاینت؛ با provider credential فرق دارد. فقط HMAC و prefix ذخیره می‌شود و مقدار کامل در create/rotate یک بار نمایش داده می‌شود.                          |
| **RPM / TPM / Concurrency** | سقف درخواست/توکن در دقیقه و درخواستهای همزمان. محدودیت کلید، پروژه و تیم با هم اعمال می‌شود؛ رد با 429 و `Retry-After` است.                                                  |
| **Budget**                  | سقف دلار یا توکن روزانه/ماهانه. دوره بر UTC است. درخواست شروع‌شده تمام می‌شود و بعد از ثبت هزینه، درخواست بعدی ممکن است 429 `budget_exceeded` بگیرد.                         |
| **Circuit breaker**         | پس از خطاهای سلامت مکرر، provider یا model موقتاً `open` می‌شود؛ `half_open` تست محدود و `closed` عادی است. cooldown/lockout مربوط به credential است، نه لزوماً کل provider. |

جزئیات دقیق: [routing](../concepts/routing.md)، [limits و budget](../concepts/limits.md)، [کلیدها](../control-api/keys.md).

## نمای کلی — `/`

KPIهای درخواست، توکن، هزینه، نرخ خطا، p50/p95، TTFT و کلید فعال را با دورهٔ قبل مقایسه می‌کند. نمودار را بین درخواست/هزینه/خطا عوض کنید. کلیک روی ستون یا ردیف مدل/کلید/پروژهٔ پرهزینه، Request Log را با همان بازه و فیلتر باز می‌کند. وضعیت breaker providerها پایین صفحه خلاصه می‌شود.

**نکتهٔ خواندن:** هزینه از usage و قیمت مدل محاسبه می‌شود؛ قیمت صفر/قدیمی گزارش هزینه را نادرست می‌کند. «بسته» در وضعیت provider یعنی breaker **closed** و عادی است، نه غیرفعال.

![نمای کلی با KPI، نمودار و مصرف برتر](screenshots/overview.png)

## Providerها — `/providers`

برای OWNER و ADMIN امکان نوشتن وجود دارد.

1. **افزودن provider:** preset را انتخاب کنید. برای Azure/OpenAI-compatible مقدار Base URL را کامل کنید. نام و credential را وارد کنید؛ در تنظیمات شبکه proxy، چهار timeout و max concurrency را فقط در صورت نیاز تغییر دهید.
2. **تست:** تست کارت provider از credential پیش‌فرض و تست ردیف از همان credential استفاده می‌کند. نتیجه latency، status و گاهی تعداد مدل را نشان می‌دهد. 401/403 را با سلامت شبکه اشتباه نگیرید.
3. **کشف مدل‌ها:** مدلهای upstream را با کاتالوگ سازمان مقایسه می‌کند. مدل شناخته‌شده با قیمت کاتالوگ اضافه می‌شود؛ برای مدل ناشناخته قیمت ورودی/خروجی را وارد کنید.
4. **Credentialها:** نام قابل تشخیص و وزن بدهید. هدر سفارشی به شکل `name: value` در هر خط و proxy اختصاصی اختیاری است. بعد از ذخیره فقط secret ماسک‌شده و نام هدرها دیده می‌شود.
5. **چرخش/غیرفعال‌سازی:** برای تعویض راز، **چرخش** را بزنید و مقدار تازه بدهید؛ سپس تست کنید. disable فوری برای عزل credential است. حذف provider soft است و آن را غیرفعال می‌کند؛ حذف مدل در استفاده به دلیل وابستگی ممکن است رد شود.

**چک بعد از تغییر:** provider و credential فعال‌اند، تست موفق است، مدل/alias وجود دارد و یک درخواست آزمایشی در لاگ به provider موردنظر می‌رسد. دیدن breaker closed به‌تنهایی اثبات صحت credential نیست.

![مدیریت Provider و Credential با دادهٔ mock](screenshots/providers.png)

## کلیدهای مجازی — `/keys`

فهرست بر اساس نام/prefix، پروژه و وضعیت فیلتر می‌شود. هزینه/تعداد/توکن هر کلید در بازهٔ فعلی دیده می‌شود.

### ساخت

پروژه و نام را انتخاب کنید. `allowedModels` خالی یعنی همهٔ مدلهای سازمان؛ برای کاهش سطح دسترسی نام model/alias/combo را با کاما یا خط جدید وارد کنید. RPM، TPM و max concurrency اختیاری‌اند. انقضا، IP/CIDR allowlist و بودجهٔ روزانه/ماهانه را متناسب با مصرف‌کننده تنظیم کنید.

### چرخش امن

1. **چرخش** و مهلتٔ کلید قدیم (پیش‌فرض ۲۴ ساعت) را تعیین کنید.
2. کلید تازهٔ یک‌بارنمایش را در secret manager بگذارید و کلاینت‌ها را به آن منتقل کنید.
3. کلید قدیم تا پایان grace کار می‌کند؛ پس از مهاجرت، با لاگ/آخرین استفاده مطمئن شوید دیگر مصرفی ندارد. برای نشت فعال منتظر grace نمانید و **ابطال** فوری کنید.

وضعیت `rotating` یعنی جایگزین صادر شده؛ `expired` و `revoked` قابل استفاده نیستند. MEMBER هم می‌تواند کلید بسازد، VIEWER فقط مشاهده می‌کند.

![فهرست کلیدهای مجازی و محدودیتها](screenshots/keys.png)

## مدل‌ها و Combo — `/models`

این صفحه سه بخش مدل، alias و combo دارد.

- **مدل:** از کاتالوگ انتخاب کنید تا قیمت، context و قابلیت‌ها پر شود، یا custom بسازید. `slug` نامی است که در API استفاده می‌شود؛ `upstreamModel` نام واقعی provider است. قیمتهای input/output بر یک میلیون توکن و به USD وارد می‌شوند. ویرایش قیمت دستی مدل را از sync کاتالوگ جدا می‌کند؛ sync کاتالوگ مدلهای وابسته را به نسخهٔ تازه به‌روز می‌کند.
- **Combo:** حداقل یک و حداکثر ۲۰ مدل یکتا اضافه کنید. ترتیب را با drag یا فلش عوض کنید. retry تلاش مجدد روی کاندیدا و fallback رفتن به کاندیدای بعدی است؛ هر دو را محدود نگه دارید. پیش‌نمایش اجرا ترتیب priority/round-robin یا توزیع وزنی را قبل از ذخیره نشان می‌دهد.
- **Alias:** نام پایدار را به model یا combo وصل کنید. فضای نام model/alias/combo مشترک است و تکرار نام رد می‌شود.

`bad_request` و `content_filter` فال‌بک ندارند. اگر بخشی از stream به کلاینت رفته باشد، فال‌بک دیگر انجام نمی‌شود. timeout نهایی provider بر تنظیم combo اولویت دارد.

![مدیریت مدل، alias و Combo](screenshots/models.png)

## لاگ درخواست‌ها — `/logs`

زمان، مدل درخواستی، HTTP status/error code، مجموع توکن، هزینه و latency نمایش داده می‌شود. فیلترهای ایجادشده از Overview به‌صورت chip و query parameter در URL می‌آیند؛ لینک قابل اشتراک است. حذف chip فیلتر را پاک می‌کند. جدول با اسکرول صفحهٔ بعد را می‌گیرد و دکمهٔ «بیشتر» نیز در صورت وجود cursor نمایش داده می‌شود.

- برای عیب‌یابی، بازه را کوچک و مدل/کلید/پروژه/status را محدود کنید.
- این صفحه metadata است؛ prompt و response کامل را نشان نمی‌دهد. `X-Request-Id` پاسخ gateway را با لاگ ساخت‌یافته gateway/worker مرتبط کنید.
- latency پایان‌به‌پایان با TTFT فرق دارد. خطای provider را با خطای admission مثل rate limit یا budget اشتباه نگیرید.
- اگر درخواست تازه دیده نمی‌شود، ابتدا کمی صبر و فیلترها را بررسی کنید؛ سپس backlog صف و worker را طبق [Runbook](../runbook.md#۸-تأخیر-یا-افت-usage-و-لاگ-درخواست) بسنجید.

![لاگ درخواستها با فیلتر و هزینه](screenshots/logs.png)

## سلامت — `/health`

- **Nodes:** شناسه replica، نسخهٔ config، ready و last seen. نسخه‌های بسیار متفاوت یا last seen قدیمی نشانهٔ مشکل sync/heartbeat است.
- **Providers:** breaker، تعداد خطا/کل و زمان half-open بعدی. credentialها cooldown، disable موقت یا lockout مدل را جدا نشان می‌دهند.
- **Models:** فقط مدلهایی که breaker غیر closed دارند فهرست می‌شوند؛ پیام «همه بسته» یعنی وضعیت breaker عادی است.

OWNER و ADMIN می‌توانند reset بزنند. reset **رفع علت نیست** و credential اشتباه یا quota تمام‌شده را سالم نمی‌کند؛ اول اتصال و خطا را اصلاح کنید، سپس در صورت نیاز reset و یک درخواست آزمایشی بزنید. reset در audit log ثبت می‌شود و به replicaهای در دسترس اعلام می‌شود.

![سلامت نودها، providerها و credentialها](screenshots/health.png)

## سازمان — `/organization`

- نام سازمان را OWNER/ADMIN تغییر می‌دهد. در صورت چند عضویت، انتخاب سازمان در همین صفحه است.
- اعضا با نقش OWNER، ADMIN، MEMBER یا VIEWER دعوت می‌شوند. دعوت pending قابل ابطال است. اگر SMTP تنظیم نشده باشد، لینک دعوت را امن به شخص برسانید؛ آن را در کانال عمومی نگذارید.
- تیم برای گروه‌بندی پروژه است و پروژه مالک کلیدهای مجازی و مرز گزارش/limit است. حذف تیم/پروژه را پیش از بررسی وابستگیها انجام ندهید.
- حذف عضو یا تنزیل نقش OWNER باید با مالک جایگزین و بررسی دسترسی انجام شود. برای کاربر عادی کمترین نقش لازم را بدهید.

| نقش    | دسترسی اصلی                                      |
| ------ | ------------------------------------------------ |
| OWNER  | مدیریت کامل سازمان و نقشها                       |
| ADMIN  | مدیریت provider/config و اعضای مجاز، reset سلامت |
| MEMBER | ساخت پروژه و کلید، مشاهده و کار عملیاتی مجاز     |
| VIEWER | مشاهده؛ دکمه‌های نوشتن/reset ندارد               |

![اعضا، دعوتها، تیمها و پروژهها](screenshots/organization.png)

## راهنمای اتصال — `/guides`

Claude Code، Codex، Cursor، Cline، Roo Code، Continue، Aider، OpenAI Python/Node، Anthropic SDK و curl پشتیبانی می‌شوند.

1. ابزار و نام model/alias را انتخاب کنید.
2. کلید تازه بسازید یا مقدار کامل کلید موجود را موقتاً وارد کنید. انتخاب نام کلید از فهرست، مقدار secret را بازیابی **نمی‌کند**.
3. snippet را کپی کنید. بعد از کپی، مقدار واردشده از صفحه پاک می‌شود؛ snippet کپی‌شده حاوی راز است پس آن را در issue/chat عمومی paste نکنید.
4. endpoint OpenAI معمولاً `<gateway>/v1` و Anthropic ریشهٔ gateway است. مدل را به نام واقعی سازمان خود تغییر دهید؛ `gpt-4.1` صرفاً پیش‌فرض/نمونه است.

![راهنمای اتصال ابزارها](screenshots/guides.png)

## حساب — `/account`

رمز فعلی و رمز تازهٔ حداقل ۱۰ کاراکتری را وارد کنید. پس از تغییر، همهٔ نشست‌ها باطل و به login می‌روید. رمز را در password manager نگه دارید؛ در screenshot یا فرم دیگری وارد نکنید.

![تغییر رمز حساب](screenshots/account.png)

## سناریوهای رایج

### الف) اول اشتراک، بعد API ارزان

1. برای مدل اشتراکی و API ارزان دو provider جدا و credential سالم بسازید؛ تست هر دو موفق باشد.
2. مدل متناظر هر provider را با نام upstream، context و قیمت درست ثبت کنید.
3. Combo بسازید؛ `priority`، مدل اشتراکی order 0 و API ارزان order 1.
4. `fallbackOn` را فقط برای خطاهایی بگذارید که جابه‌جایی معنا دارد، معمولاً `rate_limit`، `overloaded`، `server`، `timeout` و `connection`. برای 401/403 ابتدا credential را اصلاح کنید و به fallback کورکورانه تکیه نکنید.
5. alias ثابت به combo بدهید؛ کلید مجازی فقط همین alias را مجاز کند.
6. با provider سالم یک 200 بگیرید. سپس در محیط تست primary را غیرفعال/خطادار کنید و ببینید پاسخ به secondary می‌رسد و header/لاگ attempt آن را ثابت می‌کند. در production خرابی عمدی بدون مجوز انجام ندهید.

### ب) فال‌بک بین چند credential یک provider

1. دو credential جدا با سهمیه/حساب مستقل و نام روشن بسازید؛ وزن اولیهٔ مساوی بدهید.
2. مدل را فقط یک‌بار برای provider ثبت کنید؛ credentialها کاندیداهای همان مدل می‌شوند.
3. کلید مجازی و combo/alias را بسازید و `rate_limit` را در fallback مجاز کنید.
4. در تست، credential اول را 429 کنید. انتظار: credential دیگر امتحان می‌شود و اولی cooldown می‌گیرد؛ 429 مخصوص مدل ممکن است فقط lockout همان مدل باشد.
5. Health و لاگ را بررسی کنید. چند credential روی یک حساب/سهمیهٔ مشترک، ظرفیت مستقل ایجاد نمی‌کند.

### ج) مهاجرت بدون تغییر نام مدل در کلاینت

alias پایدار بسازید و کلید را به آن محدود کنید. ابتدا alias را به مدل فعلی وصل کنید؛ مدل جدید را تست و سپس مقصد alias را عوض کنید. یک درخواست آزمایشی و نرخ خطا/هزینه را قبل و بعد مقایسه کنید. rollback از نظر کلاینت فقط برگرداندن مقصد alias است.

## خطاهای رایج

| مشاهده                                    | معنا و اقدام اول                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 401 `invalid_api_key` / `api_key_expired` | کلید کامل درست است، revoked/expired نیست و به همان سازمان/محیط می‌رود. در صورت تردید rotate کنید.            |
| 403 `model_not_allowed`                   | نام model/alias در `allowedModels` کلید نیست؛ محدودیت را اصلاح یا مدل مجاز بفرستید.                          |
| 404 `model_not_found`                     | model/alias/combo در سازمان وجود ندارد یا نام اشتباه است؛ از صفحه Models نام دقیق را بگیرید.                 |
| 429 `rate_limited`                        | RPM/TPM/concurrency یکی از scopeها پر است؛ `Retry-After` را رعایت و الگوی burst را اصلاح کنید.               |
| 429 `budget_exceeded`                     | سقف دوره رسیده؛ مصرف را بررسی و در صورت نیاز بودجه را آگاهانه اصلاح کنید. شمارش دوره UTC است.                |
| 503 `no_available_provider`               | provider/model/credential غیرفعال، breaker باز یا cooldown است. Health را ببینید و بعد از رفع علت تست کنید.  |
| 401/403 از upstream                       | راز، دسترسی یا quota upstream را بررسی کنید. breaker closed بودن به‌تنهایی سلامت راز را ثابت نمی‌کند.        |
| پاسخ provider با فرمت ابزار کار نمی‌کند   | Base URL و wire protocol ابزار را با guide تطبیق دهید؛ نام alias و قابلیت tools/streaming مدل را بررسی کنید. |

برای قطعی زیرساخت و نشت راز از [Runbook عملیاتی](../runbook.md) استفاده کنید.
