[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Glossary

Core DiRouter concepts. Use these names consistently in code, APIs, and the dashboard. Some options below describe the target product rather than completed functionality.

## Core concepts

### Provider

An LLM service to which gateway forwards requests, such as OpenAI, Anthropic, Gemini, Azure OpenAI, or an OpenAI-compatible server (vLLM, Ollama, and others). Each provider has a `type` (adapter), `baseUrl`, timeout/proxy settings, and one or more credentials.

### Credential

An API key or other credential for a provider. A provider can have multiple credentials to distribute traffic and continue when one enters cooldown. Credentials are encrypted with AES-256-GCM and `MASTER_KEY`; plaintext secrets must never be stored or logged.

### Model

A specific model on one provider, identified by a public DiRouter `slug` (for example, `openai/gpt-4.1`), an `upstreamModel`, prices, a context window, and capabilities such as tools, vision, and reasoning. The same underlying model on two providers, such as OpenAI and Azure, is represented by two Model records.

### Alias

An alternative name supplied in the client's `model` field that resolves to a Model or Combo. For example, `gpt-4.1` can resolve to `openai/gpt-4.1`, or `best` to a combo. Aliases allow the underlying model to change without client changes.

### Combo

An ordered group of models with a selection strategy, retry policy, and timeouts. MVP contracts define `priority`, `round-robin`, and `weighted`; other strategies belong to later work. When a target fails, gateway may fall back to the next target. Combos are central to DiRouter's resilience.

### Virtual Key

A DiRouter API key issued to a user or application, such as `dr-live-...`. Clients authenticate with it instead of a provider's real key. Each virtual key belongs to a Project and can restrict models, rate limits, budgets, expiration, and source IPs. Only its HMAC-SHA256 hash is stored; the raw key is shown once at creation.

### Budget

A cost or token ceiling for a virtual key, project, or team. The current database design supports daily and monthly budgets; broader periods such as weekly or total are future options. Monetary values are USD decimal strings at contract boundaries, stored as `Decimal(18,8)` and calculated with BigInt fixed-point arithmetic. Reaching a budget returns `budget_exceeded` with HTTP 429.

## Access hierarchy

| Concept          | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| **Organization** | Top-level owner of providers, teams, and user memberships                   |
| **Team**         | A grouping of projects with shared budgets and limits                       |
| **Project**      | A unit of consumption to which virtual keys belong                          |
| **User**         | A dashboard user with an RBAC role; MVP memberships are organization-scoped |

## Architecture concepts

| Concept             | Description                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data plane**      | Gateway: the hot path of every LLM request                                                                                                                                       |
| **Control plane**   | control-api, worker, and dashboard: management and reporting                                                                                                                     |
| **ConfigSnapshot**  | A complete, versioned configuration containing providers, models, combos, aliases, virtual keys, and limits; published by control-api and retained in gateway memory and on disk |
| **UsageEvent**      | A request's consumption event (tokens, cost, attempt chain), delivered asynchronously to worker                                                                                  |
| **Canonical model** | The internal request/response format to which inbound and outbound APIs are translated                                                                                           |
| **Inbound API**     | The API used by the client (`openai.chat` or `anthropic.messages`); responses and errors use the same format                                                                     |
| **Ledger**          | The financial usage record in PostgreSQL; the accounting source of truth                                                                                                         |
| **Attempt**         | One attempt to send a request to a Model using a Credential; a request can have multiple attempts                                                                                |

## Resilience concepts

| Concept             | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Fallback**        | Move to the next combo target after the current target fails                                                  |
| **Retry**           | Retry the same target with backoff and jitter, for transient errors only                                      |
| **Circuit Breaker** | Temporarily stop sending to a repeatedly failing provider/model; states are `closed`, `open`, and `half-open` |
| **Cooldown**        | Temporarily exclude a rate-limited credential, using `Retry-After` where available                            |
| **Lockout**         | Temporarily exclude a model on one provider, for example when it becomes unavailable                          |
| **Bulkhead**        | A concurrency ceiling per provider or tenant so a slow component cannot exhaust the whole system              |
| **TTFT**            | Time to first token; the first meaningful response/token latency measurement                                  |
| **Fail mode**       | Limiter/budget behavior when Valkey is unavailable: `open` permits requests and `closed` rejects them         |
| **Outbox**          | Gateway's local file holding UsageEvents while the queue is unavailable                                       |
| **Idempotency key** | An event's unique key used to prevent duplicate charges                                                       |

---

<a id="persian"></a>

# واژه‌نامه

مفاهیم اصلی DiRouter. این نام‌ها را در کد، APIها و داشبورد یکسان به کار ببرید. برخی گزینه‌های زیر به محصول هدف اشاره دارند و نه قابلیت‌های تکمیل‌شده.

## مفاهیم اصلی

### Provider (ارائه‌دهنده)

سرویس LLM که gateway درخواست‌ها را به آن ارسال می‌کند، مانند OpenAI، Anthropic، Gemini، Azure OpenAI یا یک سرور سازگار با OpenAI (vLLM، Ollama و موارد دیگر). هر provider دارای `type` (آداپتور)، `baseUrl`، تنظیمات timeout/proxy و یک یا چند credential است.

### Credential (اعتبار)

کلید API یا اعتبار دیگری برای یک provider. یک provider می‌تواند چند credential داشته باشد تا ترافیک را توزیع کند و وقتی یکی وارد cooldown می‌شود ادامه دهد. credentialها با AES-256-GCM و `MASTER_KEY` رمزنگاری می‌شوند؛ اسرار متنی نباید هرگز ذخیره یا log شوند.

### Model (مدل)

یک مدل مشخص روی یک provider که با `slug` عمومی DiRouter (برای نمونه `openai/gpt-4.1`)، `upstreamModel`، قیمت‌ها، پنجرهٔ context و قابلیت‌هایی مانند ابزارها، بینایی و استدلال مشخص می‌شود. همان مدل زیربنایی روی دو provider، مانند OpenAI و Azure، با دو رکورد Model نمایش داده می‌شود.

### Alias (نام مستعار)

نام جایگزینی که در فیلد `model` درخواست کلاینت آمده و به یک Model یا Combo تبدیل می‌شود. برای نمونه `gpt-4.1` می‌تواند به `openai/gpt-4.1` و `best` به یک combo تبدیل شود. aliasها اجازه می‌دهند مدل زیربنایی بدون تغییر در کلاینت عوض شود.

### Combo (ترکیب)

گروه مرتبی از مدل‌ها همراه با استراتژی انتخاب، سیاست retry و timeoutها. قراردادهای MVP سه مورد `priority`، `round-robin` و `weighted` را تعریف می‌کنند؛ سایر استراتژی‌ها به کارهای بعدی تعلق دارند. وقتی یک target شکست می‌خورد، gateway ممکن است به target بعدی fallback کند. comboها محور تاب‌آوری DiRouter هستند.

### Virtual Key (کلید مجازی)

کلید API خود DiRouter که به یک کاربر یا برنامه داده می‌شود، مانند `dr-live-...`. کلاینت‌ها به جای کلید واقعی provider با آن احراز هویت می‌کنند. هر virtual key به یک Project تعلق دارد و می‌تواند مدل‌ها، محدودیت نرخ، budgetها، تاریخ انقضا و IPهای مبدأ را محدود کند. فقط هش HMAC-SHA256 آن ذخیره می‌شود؛ کلید خام هنگام ساخت یک‌بار نمایش داده می‌شود.

### Budget (بودجه)

سقف هزینه یا توکن برای یک virtual key، project یا team. طراحی فعلی پایگاه داده از budgetهای روزانه و ماهانه پشتیبانی می‌کند؛ دوره‌های گسترده‌تر مانند هفتگی یا کل، گزینه‌های آینده هستند. مقادیر پولی در مرزهای قرارداد به صورت رشتهٔ اعشاری USD هستند، در PostgreSQL به صورت `Decimal(18,8)` ذخیره و با حساب نقطه‌ثابت BigInt محاسبه می‌شوند. رسیدن به budget، پاسخ `budget_exceeded` با HTTP 429 برمی‌گرداند.

## سلسله‌مراتب دسترسی

| مفهوم            | توضیح                                                                |
| ---------------- | -------------------------------------------------------------------- |
| **Organization** | مالک سطح بالای providerها، teamها و عضویت کاربران                    |
| **Team**         | گروهی از projectها با budgetها و محدودیت‌های مشترک                   |
| **Project**      | واحد مصرف که virtual keyها به آن تعلق دارند                          |
| **User**         | کاربر داشبورد با نقش RBAC؛ عضویت‌ها در MVP در سطح organization هستند |

## مفاهیم معماری

| مفهوم               | توضیح                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data plane**      | Gateway: مسیر پرترافیک هر درخواست LLM                                                                                                                            |
| **Control plane**   | control-api، worker و داشبورد: مدیریت و گزارش‌گیری                                                                                                               |
| **ConfigSnapshot**  | پیکربندی کامل و نسخه‌دار شامل providerها، مدل‌ها، comboها، aliasها، virtual keyها و محدودیت‌ها؛ توسط control-api منتشر و در حافظه و دیسک gateway نگه‌داری می‌شود |
| **UsageEvent**      | رویداد مصرف یک درخواست (توکن‌ها، هزینه، زنجیره attemptها) که به‌صورت ناهمزمان به worker تحویل می‌شود                                                             |
| **Canonical model** | قالب داخلی درخواست/پاسخ که APIهای ورودی و خروجی به آن ترجمه می‌شوند                                                                                              |
| **Inbound API**     | APIای که کلاینت استفاده می‌کند (`openai.chat` یا `anthropic.messages`)؛ پاسخ‌ها و خطاها همان قالب را دارند                                                       |
| **Ledger**          | رکورد مالی مصرف در PostgreSQL؛ منبع حقیقت حسابداری                                                                                                               |
| **Attempt**         | یک تلاش برای ارسال درخواست به یک Model با استفاده از یک Credential؛ یک درخواست می‌تواند چند attempt داشته باشد                                                   |

## مفاهیم تاب‌آوری

| مفهوم               | توضیح                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Fallback**        | پس از شکست target فعلی، به target بعدی combo می‌رود                                                                |
| **Retry**           | تلاش مجدد روی همان target با backoff و jitter، فقط برای خطاهای گذرا                                                |
| **Circuit Breaker** | موقتاً ارسال به یک provider/model که مرتب شکست می‌خورد متوقف می‌شود؛ وضعیت‌ها `closed`، `open` و `half-open` هستند |
| **Cooldown**        | موقتاً یک credential محدودشده با نرخ را کنار می‌گذارد و در صورت وجود از `Retry-After` استفاده می‌کند               |
| **Lockout**         | موقتاً یک مدل روی یک provider کنار گذاشته می‌شود، برای نمونه وقتی در دسترس نیست                                    |
| **Bulkhead**        | سقف همزمانی به‌ازای هر provider یا tenant تا یک جزء کند نتواند کل سیستم را از پا درآورد                            |
| **TTFT**            | زمان تا اولین توکن؛ اولین اندازه‌گیری معنادار تأخیر پاسخ/توکن                                                      |
| **Fail mode**       | رفتار محدودکننده/budget وقتی Valkey در دسترس نیست: `open` درخواست‌ها را می‌پذیرد و `closed` آن‌ها را رد می‌کند     |
| **Outbox**          | فایل محلی gateway که UsageEventها را وقتی صف در دسترس نیست نگه می‌دارد                                             |
| **Idempotency key** | کلید یکتای یک رویداد برای جلوگیری از ثبت دوباره هزینه                                                              |
