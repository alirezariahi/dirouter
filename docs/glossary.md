[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Glossary

> All documentation in this repository is bilingual (English and Persian), and detailed guides live in code/docs/. See [CONTRIBUTING.md](../CONTRIBUTING.md).

Core concepts of DiRouter. The names in code, API, and dashboard are exactly these.

## Core concepts

### Provider

An LLM service to which the gateway sends requests, such as OpenAI, Anthropic, Gemini, Azure OpenAI, or any OpenAI-compatible server (vLLM, Ollama, …). Each provider has a `type` (adapter type), a `baseUrl`, timeout and proxy settings, and one or more Credentials.

### Credential

A key or credential for accessing a Provider. A Provider can have several Credentials so that load is shared among them, and if one reaches its limit (cooldown), the others are used. Credentials are encrypted with AES-256-GCM and MASTER_KEY, and are never stored or logged in plain text.

### Model

A specific model on a Provider, with its DiRouter public name (`slug`, e.g. `openai/gpt-4.1`), its model name at the provider (`upstreamModel`), price, context length, and capabilities (tools, vision, reasoning). The same model on two providers (for example GPT-4.1 on OpenAI and on Azure) is two separate Models.

### Alias

An alternative name that the client sends in the `model` field, pointing to a Model or a Combo; for example `gpt-4.1` pointing to `openai/gpt-4.1`, or `best` pointing to a Combo. With an Alias you can change the model behind a name without changing clients.

### Combo

An ordered group of Models with a selection strategy (`priority`, `round-robin`, `weighted`, `random`), a retry policy, and a timeout. If the first target fails, the gateway falls back to the next target. Combo is the core of DiRouter's resilience.

### Virtual Key

An API key that DiRouter gives to a user or application (for example `dr-live-…`). The client authenticates with it instead of the real provider key. Each Virtual Key belongs to a Project and can have allowed models, a rate limit, a Budget, an expiry date, and an IP restriction. Only the HMAC-SHA256 of the key is stored, and the key itself is shown only once, when it is created.

### Budget

A cost cap over a time period (`daily`, `weekly`, `monthly`, `total`) at the level of a Virtual Key, Project, or Team. In the API, amounts are dollar decimal strings with at most 8 decimal places; in the database they are `Decimal(18,8)`; and in calculations they use BigInt fixed-point. The current database periods are daily and monthly; weekly and total are future options. When the cap is reached, the request is rejected with the `budget_exceeded` error (HTTP 429).

## Access hierarchy

| Concept          | Description                                                    |
| ---------------- | -------------------------------------------------------------- |
| **Organization** | Top level; owns all Providers, Teams, and users                |
| **Team**         | A group of users and projects with a shared budget and limits  |
| **Project**      | Unit of usage; Virtual Keys belong to a Project                |
| **User**         | Dashboard user with a role (RBAC) in an Organization or a Team |

## Architecture concepts

| Concept             | Description                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Data plane**      | The gateway; the hot path of every LLM request                                                                                                                                       |
| **Control plane**   | control-api, worker, and dashboard; management and reporting                                                                                                                         |
| **ConfigSnapshot**  | A complete, versioned picture of the configuration (Providers, Models, Combos, Aliases, Virtual Keys, limits) that control-api publishes and the gateway keeps in memory and on disk |
| **UsageEvent**      | The usage event of each request (tokens, cost, attempt chain) that reaches the worker asynchronously                                                                                 |
| **Canonical model** | The internal request and response format into which all input and output APIs are translated                                                                                         |
| **Inbound API**     | The API the client used to send the request (`openai.chat` or `anthropic.messages`); responses and errors are returned in the same format                                            |
| **Attempt**         | One attempt to send a request to a Model and Credential; one request can have several Attempts                                                                                       |

## Resilience concepts

| Concept             | Description                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Fallback**        | Moving to the next Combo target after the current target fails                                                    |
| **Retry**           | Trying the same target again with backoff and jitter, only for transient errors                                   |
| **Circuit Breaker** | Temporarily stopping sends to a Provider or Model that fails repeatedly; states `closed`, `open`, and `half-open` |
| **Cooldown**        | Temporarily setting aside a Credential that hit a rate limit, until the `Retry-After` time                        |
| **Lockout**         | Temporarily locking a Model on a Provider (for example when the model is unavailable)                             |
| **Bulkhead**        | A cap on concurrent requests per Provider or tenant so that one slow part does not bring down the whole system    |
| **TTFT**            | Time To First Token; the time until the first byte of the response                                                |
| **Fail mode**       | The behavior of the limiter and budget when Valkey is unavailable: `open` (allow) or `closed` (reject)            |
| **Outbox**          | A local gateway file that holds UsageEvents when the queue is unavailable                                         |
| **Idempotency key** | A unique key for each event that prevents a cost from being recorded twice                                        |

---

<a id="persian"></a>

# واژه‌نامه

> تمام مستندات این مخزن دوزبانه (انگلیسی و فارسی) است و راهنماهای تفصیلی در code/docs/ نگهداری می‌شوند. برای مشارکت به [CONTRIBUTING.md](../CONTRIBUTING.md) مراجعه کنید.

مفاهیم اصلی DiRouter. نام‌ها در کد، API و داشبورد همین‌ها هستند.

## مفاهیم هسته

### Provider

یک سرویس‌دهندهٔ LLM که گیت‌وی درخواست را به آن می‌فرستد؛ مثل OpenAI، Anthropic، Gemini، Azure OpenAI یا هر سرور سازگار با OpenAI (vLLM، Ollama، …). هر provider یک `type` (نوع آداپتر)، `baseUrl`، تنظیمات timeout و proxy، و یک یا چند Credential دارد.

### Credential

یک کلید یا اعتبارنامه برای دسترسی به یک Provider. یک Provider می‌تواند چند Credential داشته باشد تا بار بین آن‌ها تقسیم شود و اگر یکی به سقف رسید (cooldown) از بقیه استفاده شود. Credentialها با AES-256-GCM و MASTER_KEY رمز می‌شوند و هرگز به‌صورت متن ساده ذخیره یا لاگ نمی‌شوند.

### Model

یک مدل مشخص روی یک Provider، با نام عمومی DiRouter (`slug`، مثلاً `openai/gpt-4.1`)، نام مدل نزد provider (`upstreamModel`)، قیمت، طول کانتکست و قابلیت‌ها (tools، vision، reasoning). یک مدل یکسان روی دو provider (مثلاً GPT-4.1 روی OpenAI و Azure) دو Model جدا است.

### Alias

یک نام جایگزین که کلاینت در فیلد `model` می‌فرستد و به یک Model یا Combo اشاره می‌کند؛ مثلاً `gpt-4.1` به `openai/gpt-4.1` یا `best` به یک Combo. با Alias می‌توان مدل پشت یک نام را بدون تغییر کلاینت‌ها عوض کرد.

### Combo

یک گروه مرتب از Modelها با یک استراتژی انتخاب (`priority`، `round-robin`، `weighted`، `random`)، سیاست retry و timeout. اگر هدف اول شکست بخورد، گیت‌وی به هدف بعدی فال‌بک می‌کند. Combo هستهٔ تاب‌آوری DiRouter است.

### Virtual Key

کلید API که DiRouter به کاربر یا اپلیکیشن می‌دهد (مثلاً `dr-live-…`). کلاینت با آن به‌جای کلید واقعی provider احراز هویت می‌کند. هر Virtual Key به یک Project تعلق دارد و می‌تواند مدل‌های مجاز، rate limit، Budget، تاریخ انقضا و محدودیت IP داشته باشد. فقط HMAC-SHA256 کلید ذخیره می‌شود و خود کلید فقط یک بار هنگام ساخت نمایش داده می‌شود.

### Budget

سقف هزینه در یک بازهٔ زمانی (`daily`، `weekly`، `monthly`، `total`) در سطح Virtual Key، Project یا Team. مبالغ در API به‌صورت رشتهٔ اعشاری دلاری با حداکثر ۸ رقم اعشار، در دیتابیس با `Decimal(18,8)` و در محاسبات با BigInt fixed-point هستند. بازه‌های فعلی دیتابیس daily و monthly هستند؛ weekly و total گزینه‌های آینده‌اند. با رسیدن به سقف، درخواست با خطای `budget_exceeded` (HTTP 429) رد می‌شود.

## سلسله‌مراتب دسترسی

| مفهوم            | توضیح                                                |
| ---------------- | ---------------------------------------------------- |
| **Organization** | بالاترین سطح؛ مالک همهٔ Providerها، Teamها و کاربران |
| **Team**         | گروهی از کاربران و پروژه‌ها با بودجه و محدودیت مشترک |
| **Project**      | واحد مصرف؛ Virtual Keyها به Project تعلق دارند       |
| **User**         | کاربر داشبورد با نقش (RBAC) در Organization یا Team  |

## مفاهیم معماری

| مفهوم               | توضیح                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data plane**      | گیت‌وی؛ مسیر داغ هر درخواست LLM                                                                                                                             |
| **Control plane**   | control-api، worker و داشبورد؛ مدیریت و گزارش                                                                                                               |
| **ConfigSnapshot**  | تصویر کامل و نسخه‌دار پیکربندی (Providerها، Modelها، Comboها، Aliasها، Virtual Keyها، محدودیت‌ها) که control-api منتشر و گیت‌وی در حافظه و دیسک نگه می‌دارد |
| **UsageEvent**      | رویداد مصرف هر درخواست (توکن، هزینه، زنجیرهٔ تلاش‌ها) که غیرهمگام به worker می‌رسد                                                                          |
| **Canonical model** | قالب داخلی درخواست و پاسخ که همهٔ APIهای ورودی و خروجی به آن ترجمه می‌شوند                                                                                  |
| **Inbound API**     | API که کلاینت با آن درخواست فرستاده (`openai.chat` یا `anthropic.messages`)؛ پاسخ و خطا به همین قالب برمی‌گردد                                              |
| **Attempt**         | یک تلاش برای ارسال درخواست به یک Model و Credential؛ یک درخواست می‌تواند چند Attempt داشته باشد                                                             |

## مفاهیم تاب‌آوری

| مفهوم               | توضیح                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| **Fallback**        | رفتن به هدف بعدی Combo بعد از شکست هدف فعلی                                                           |
| **Retry**           | تلاش دوباره روی همان هدف با backoff و jitter، فقط برای خطاهای گذرا                                    |
| **Circuit Breaker** | قطع موقت ارسال به Provider یا Model که پشت‌سرهم شکست می‌خورد؛ حالت‌های `closed`، `open` و `half-open` |
| **Cooldown**        | کنار گذاشتن موقت یک Credential که به rate limit خورده، تا زمان `Retry-After`                          |
| **Lockout**         | قفل موقت یک Model روی یک Provider (مثلاً وقتی مدل در دسترس نیست)                                      |
| **Bulkhead**        | سقف درخواست هم‌زمان برای هر Provider یا tenant تا یک بخش کند کل سیستم را از کار نیندازد               |
| **TTFT**            | Time To First Token؛ زمان تا اولین بایت پاسخ                                                          |
| **Fail mode**       | رفتار limiter و بودجه وقتی Valkey در دسترس نیست: `open` (اجازه) یا `closed` (رد)                      |
| **Outbox**          | فایل محلی گیت‌وی برای نگه داشتن UsageEventها وقتی صف در دسترس نیست                                    |
| **Idempotency key** | کلید یکتای هر رویداد که از دوبار ثبت شدن هزینه جلوگیری می‌کند                                         |
