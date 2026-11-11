[English](feature-comparison.md) · [فارسی](feature-comparison.fa.md)

<div dir="rtl">

# DiRouter — مقایسه‌ی رقبا، فهرست کامل فیچرها و پیشنهاد معماری

> تاریخ بررسی: 2026-11-07.
> نسخه‌ی تاریخی طراحی که پیش از شروع پیاده‌سازی نوشته شده است. ادعاهای محصول، تعداد، لایسنس‌ها و اعداد کارایی زیر مربوط به همان بررسی‌اند و در ترجمه‌ی انگلیسی دوباره تأیید نشده‌اند. [ADRهای پذیرفته‌شده](../../adr/README.fa.md) پیشنهادهای Go، ClickHouse و صف را برای MVP جایگزین کرده‌اند.

---

## ۱. خلاصه‌ی مدیریتی

- سه پروژه‌ی اصلی هرکدام در یک حوزه قوی‌اند:
  - **Antirion:** یک گیت‌وی سازمانی با Rust که روی کارایی، حاکمیت و دسترسی (SSO، SCIM، RBAC، audit)، guardrail و کلاسترینگ با PostgreSQL و Valkey تمرکز دارد.
  - **OmniRoute:** یک گیت‌وی محلی با بیشترین تعداد provider گزارش‌شده (بیش از ۳۵۰)، ۱۹ استراتژی مسیریابی، فشرده‌سازی context، حافظه، MCP و A2A.
  - **9Router:** یک ابزار سبک برای توسعه‌دهندگان، با fallback اشتراک/ارزان/رایگان، صرفه‌جویی توکن و نه نوع سرویس: chat، embeddings، TTS، STT، تصویر، ویدیو، جستجو و fetch.
- **هیچ پروژه‌ای همه‌ی قابلیت‌ها را با هم ندارد:** کنترل‌های سازمانی Antirion، گستره‌ی provider و مسیریابی OmniRoute، و **صورت‌حساب و فروش اعتبار** که بیشتر در new-api دیده می‌شود.
- فرصت DiRouter یک محصول در یک مونوریپو است، با **data plane سریع و تاب‌آور**، **control plane کامل** (کاربران، تیم‌ها، بودجه‌ها، صورت‌حساب) و **داشبورد عملیاتی قوی**.
- **پیشنهاد فنی اولیه:** NestJS + React + PostgreSQL برای control plane و داشبورد مناسب است. پژوهش **Go را برای مسیر داغ درخواست‌ها (data plane)** پیشنهاد می‌کرد (بخش ۷)، در کنار **Valkey/Redis** و **ClickHouse**. ADRهای بعدی به‌جای آن یک MVP با TypeScript، aggregateهای PostgreSQL و BullMQ را انتخاب کردند.

---

## ۲. پروژه‌های بررسی‌شده

| #   | پروژه                                                   | نوع                               | زبان                 | لایسنس ثبت‌شده در پژوهش                                     | استقرار                                      | تمرکز اصلی                                    |
| --- | ------------------------------------------------------- | --------------------------------- | -------------------- | ----------------------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| 1   | **Antirion**                                            | گیت‌وی سازمانی                    | Rust، یک باینری      | Apache-2.0؛ همه‌ی فیچرها رایگان                             | فقط Self-hosted، تک‌نود یا کلاستر، Helm      | کارایی، حاکمیت، guardrail                     |
| 2   | **OmniRoute**                                           | گیت‌وی محلی/ابری                  | Node/TS، Electron    | MIT                                                         | npm، Docker، دسکتاپ، Termux، PWA، Cloud پولی | Providers، مسیریابی، فشرده‌سازی               |
| 3   | **9Router**                                             | گیت‌وی محلی برای ابزارهای کدنویسی | Node/TS              | MIT                                                         | npm، تونل Cloudflare                         | فال‌بک اشتراک/رایگان، صرفه‌جویی توکن          |
| 4   | **LiteLLM**                                             | Proxy و SDK                       | Python؛ Rust در beta | MIT؛ فیچرهای enterprise پولی                                | Docker، Helm، Terraform، PostgreSQL          | اکوسیستم جاافتاده، بیش از ۱۰۰ provider        |
| 5   | **Bifrost** (Maxim)                                     | گیت‌وی با کارایی بالا             | Go                   | Apache-2.0؛ فیچرهای enterprise پولی                         | Docker، باینری                               | کارایی، virtual keys، MCP                     |
| 6   | **Portkey Gateway**                                     | گیت‌وی/پلتفرم                     | TS                   | MIT؛ پلتفرم پولی؛ پژوهش Palo Alto را مالک معرفی می‌کند      | Node، Workers، Kubernetes، Cloud             | مسیریابی مبتنی بر config، بیش از ۵۰ guardrail |
| 7   | **new-api** (QuantumNous، نسخه‌ی گسترش‌یافته‌ی one-api) | گیت‌وی فروش API                   | Go + React           | AGPL/MIT\*                                                  | Docker، SQLite/MySQL/PG، ClickHouse          | **صورت‌حساب، شارژ، فروش اعتبار**              |
| 8   | **CLIProxyAPI**                                         | پروکسی حساب‌های OAuth             | Go                   | MIT                                                         | Docker، cluster                              | Codex، Claude Code، Gemini CLI، حساب‌های Grok |
| 9   | **Claude Code Router (CCR)**                            | control plane محلی برای ایجنت‌ها  | TS                   | MIT                                                         | npm، دسکتاپ، Docker                          | پروفایل ایجنت‌ها، مسیریابی شرطی               |
| 10  | **TensorZero**                                          | گیت‌وی، ارزیابی و بهینه‌سازی      | Rust                 | Apache-2.0؛ پژوهش آرشیو شدن آن را در May/June 2026 ثبت کرده | Docker                                       | A/B tests، evaluations، fine-tuning           |
| 11  | **Helicone AI Gateway**                                 | گیت‌وی و observability            | Rust                 | ناهمخوانی Apache/GPL در پژوهش                               | npx، Docker، Kubernetes                      | مسیریابی PeakEWMA، کش                         |
| 12  | **LLM Gateway** (theopenco)                             | گیت‌وی SaaS/self-hosted           | TS (Hono، Next.js)   | AGPLv3 و نسخه‌ی enterprise                                  | Docker image یکپارچه                         | الگوهای مونوریپو و multitenancy               |
| 13  | **OpenRouter**                                          | بازار SaaS بسته                   | مشخص نشده            | تجاری                                                       | فقط Cloud                                    | Credits، BYOK، provider routing               |
| 14  | **Kong / Envoy AI Gateway / agentgateway**              | افزونه‌های API gateway            | Lua، Go، Rust        | OSS و enterprise                                            | Kubernetes                                   | تیم‌های پلتفرم                                |

\* لایسنس new-api را پیش از استفاده‌ی مجدد از کد بررسی کنید.

> **محدودیت کارایی در پژوهش اصلی:** اعدادی مانند 0.5 ms برای Antirion و 11 microseconds برای Bifrost را خود سازنده‌ها گزارش کرده‌اند، با روش‌های متفاوت اندازه‌گیری شده‌اند و مستقیماً قابل مقایسه نیستند.

---

## ۳. فهرست ترکیبی فیچرها

کلید منابع: **A** = Antirion، **O** = OmniRoute، **N** = 9Router، **L** = LiteLLM، **B** = Bifrost، **P** = Portkey، **NA** = new-api، **C** = CLIProxyAPI، **R** = CCR، **T** = TensorZero، **H** = Helicone، **G** = LLM Gateway، **OR** = OpenRouter. `(ent)` یعنی نسخه‌ی enterprise.

اولویت‌های اولیه‌ی پژوهش: **P0** = MVP، **P1** = نسخه‌ی ۱، **P2** = بعداً. این اولویت‌های پژوهشی جایگزین برنامه‌ی اسپرینت بعدی نمی‌شوند.

### ۳.۱ سازگاری API و تبدیل فرمت

| فیچر                                                                             | منابع          | اولویت |
| -------------------------------------------------------------------------------- | -------------- | ------ |
| Endpoint سازگار با OpenAI Chat Completions                                       | همه            | P0     |
| OpenAI Responses API                                                             | O، NA، C، R    | P0     |
| Anthropic Messages API، شامل پشتیبانی از Claude Code                             | A، O، NA، C، R | P0     |
| Gemini generateContent / Interactions                                            | A، O، NA، C، R | P1     |
| Bedrock dialect ورودی                                                            | A              | P2     |
| تبدیل دوطرفه‌ی فرمت، شامل stream، tool call و reasoning                          | A، O، N، NA    | P0     |
| پاسخ‌های SSE به‌صورت streaming و غیر streaming                                   | همه            | P0     |
| WebSocket / Realtime API                                                         | NA، P، C       | P2     |
| `/v1/models` و کاتالوگ مدل                                                       | O، R           | P0     |
| Function calling، ابزارها، خروجی ساختاریافته (JSON Schema)                       | C، T، NA       | P0     |
| ورودی‌های چندرسانه‌ای: تصویر و فایل                                              | C، T، P        | P1     |
| پشتیبانی drop-in از SDKهای رسمی، LangChain و Vercel AI SDK با تغییر فقط base URL | A، B           | P0     |

### ۳.۲ انواع سرویس (Modalities)

| فیچر                                                                     | منابع    | اولویت |
| ------------------------------------------------------------------------ | -------- | ------ |
| Chat/LLM                                                                 | همه      | P0     |
| Embeddings                                                               | N، NA، T | P1     |
| Rerank                                                                   | NA       | P2     |
| TTS / STT / ترجمه                                                        | N، NA، P | P2     |
| تولید تصویر                                                              | N، NA، P | P2     |
| تولید ویدیو و تسک‌های ناهمگام (Midjourney، Suno، Runway) با پیگیری وضعیت | N، NA    | P2     |
| جستجوی وب به‌صورت سرویس (Tavily، Brave، Exa، Serper و غیره)              | N، O     | P2     |
| Web fetch (Firecrawl، Jina Reader)                                       | N        | P2     |
| Batch inference و Files API                                              | T، L     | P2     |
| Fusion: افزودن vision یا جستجوی وب به مدلی که آن را ندارد                | R        | P2     |

### ۳.۳ Providerها و روش‌های اتصال

| فیچر                                                                                                                                                                                               | منابع          | اولویت                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------- |
| Providerهای اصلی با API key: OpenAI، Anthropic، Gemini، Azure، Bedrock، Vertex، Mistral، Cohere، Groq، Together، Fireworks، DeepSeek، xAI، Cerebras، DeepInfra، Perplexity، OpenRouter، NVIDIA NIM | A، O، L        | P0                     |
| هر سرور سازگار با OpenAI (vLLM، Ollama، LM Studio، llama.cpp، SGLang، TGI)                                                                                                                         | همه            | P0                     |
| Providerهای ارزان چینی (GLM/Z.AI، Kimi، MiniMax، Qwen، SiliconFlow، Bailian)                                                                                                                       | N، O، R        | P1                     |
| **اشتراک‌های OAuth** (Claude Code، Codex، Gemini CLI، Copilot، Cursor، Kimi Code، Grok Build، Antigravity، Kiro)                                                                                   | O، N، C، L     | P1، با محدودیت‌ها      |
| احراز هویت با web-cookie (ChatGPT Web، Claude Web، Gemini Web)                                                                                                                                     | O، N           | پیشنهاد اولیه: حذف شود |
| مسیرهای رایگان و بدون کلید (Pollinations، OpenCode Free، Cloudflare AI)                                                                                                                            | O، N           | P2                     |
| چند اکانت یا چند کلید برای هر provider (credential pool)                                                                                                                                           | O، N، C، NA، R | P0                     |
| تعریف provider سفارشی از طریق UI/پلاگین                                                                                                                                                            | C، R، NA       | P1                     |
| Protocol probing، کشف خودکار مدل‌ها، تست اتصال                                                                                                                                                     | R، NA          | P1                     |
| وارد کردن ورودهای محلی ابزارها، مثل `~/.codex`                                                                                                                                                     | R              | P2                     |
| کاتالوگ قیمت مدل‌ها، همیشه به‌روز                                                                                                                                                                  | P، O           | P0                     |
| Model mapping و aliasها: نام مجازی به مدل واقعی                                                                                                                                                    | NA، R          | P0                     |

> **هشدار پژوهش:** استفاده از اشتراک‌های شخصی OAuth یا cookie پشت یک gateway چندکاربره ممکن است با شرایط خدمات آن سرویس‌ها در تضاد باشد و به محدودیت حساب منجر شود. پژوهش هشدار مشابهی را برای MITM bridge در 9Router یادآوری کرده بود. پیشنهاد آن این بود که چنین پشتیبانی‌ای فقط به‌صورت پلاگین اختیاری برای استفاده‌ی شخصی و با اعلان صریح در UI باشد، و MITM bridge و یکپارچه‌سازی web-cookie از هسته کنار گذاشته شوند. پیش از پیاده‌سازی هر یکپارچه‌سازی، شرایط قابل اعمال را دوباره بررسی کنید.

### ۳.۴ مسیریابی (Routing)

| فیچر                                                                                            | منابع          | اولویت |
| ----------------------------------------------------------------------------------------------- | -------------- | ------ |
| Priority / fill-first، مثلاً مصرف اول سهمیه‌ی اشتراک                                            | O، N           | P0     |
| Weighted split                                                                                  | A، O، P، H، NA | P0     |
| Round-robin و sticky round-robin                                                                | O، N، C        | P0     |
| Least-used / least-busy                                                                         | O، L           | P1     |
| Power-of-two-choices (P2C) و PeakEWMA مبتنی بر latency                                          | O، H           | P1     |
| Least-latency                                                                                   | A، H           | P1     |
| Least-cost / بهینه‌سازی هزینه                                                                   | A، O، H، P     | P1     |
| آگاه از headroom: ترجیح سهمیه‌ی باقی‌مانده‌ی بیشتر                                              | O              | P1     |
| آگاه از زمان ریست / پنجره‌ی ریست: در نظر گرفتن زمان ریست سهمیه                                  | O              | P1     |
| Last-known-good                                                                                 | O              | P1     |
| بهینه‌سازی context / context-relay: انتخاب بر اساس طول context                                  | O              | P1     |
| بهینه‌سازی کش: حفظ prompt cache نزد همان provider از طریق session affinity                      | O، NA          | P1     |
| Random / strict-random                                                                          | O              | P2     |
| Fusion / pipeline: ترکیب چند مدل                                                                | O              | P2     |
| **Classifier / مسیریابی لایه‌ای:** دسته‌بندی وظایف و انتخاب مدل                                 | A، C           | P1     |
| aliasهای خودکار: `auto`، `auto/coding`، `auto/fast`، `auto/cheap`، `auto/smart`، `auto/offline` | O              | P1     |
| امتیازدهی تطبیقی چندعاملی؛ پژوهش ۱۵ عامل را در OmniRoute ثبت کرده است                           | O، B(ent)      | P2     |
| **Combo / مدل مجازی:** زنجیره‌ای از مدل‌ها با استراتژی و fallback                               | O، N، R        | P0     |
| مسیریابی شرطی بر اساس header، body، tag یا metadata                                             | P، R، L        | P1     |
| سیاست‌های جداگانه برای تیم و پروژه، با گزارش سهم ترافیک هر قاعده                                | A              | P1     |
| Prefixها و بازنویسی درخواست                                                                     | R              | P1     |
| Channel affinity: اتصال کاربر به یک کانال                                                       | NA             | P1     |
| A/B tests، canary، adaptive bandits                                                             | T، P           | P2     |

### ۳.۵ تاب‌آوری (Resilience) — اولویت ویژه

| فیچر                                                                          | منابع          | اولویت |
| ----------------------------------------------------------------------------- | -------------- | ------ |
| fallback چندسطحی: اشتراک به API به ارزان به رایگان                            | O، N، A        | P0     |
| fallback بر اساس نوع خطا: 429، 5xx، timeout، content policy، context window   | P، L           | P0     |
| Retry با exponential backoff و jitter                                         | A، P، T        | P0     |
| **Request hedging:** ارسال به provider دوم وقتی اولی کند است                  | A              | P1     |
| **Circuit breaker برای هر provider:** حالت‌های closed، open و half-open probe | A، O           | P0     |
| Cooldown برای هر کلید یا اکانت، در حالی که بقیه‌ی اعتبارها ادامه می‌دهند      | O، L           | P0     |
| Model lockout: فقط مدلی که rate-limit شده کنار گذاشته شود، نه کل اتصال        | O              | P0     |
| Timeout جداگانه برای اتصال، first-token (TTFT) و کل درخواست                   | P، T           | P0     |
| غیرفعال و دوباره فعال کردن خودکار کانال بر اساس خطاها و تست دوره‌ای           | NA             | P0     |
| Health check فعال providerها                                                  | L، O           | P0     |
| توزیع ترافیک بین کلیدها برای کاهش فشار rate-limit                             | O، B           | P0     |
| اجرای چندنودی stateless با شمارنده‌های مشترک Valkey                           | A، NA          | P0     |
| Graceful shutdown و drain کردن streamهای باز                                  | بدون منبع مشخص | P0     |
| ادامه‌ی کار هنگام قطعی DB/Redis: کش محلی config و fail-open قابل تنظیم        | بدون منبع مشخص | P0     |
| بازیابی stream قطع‌شده، تا جایی که امکان‌پذیر است                             | بدون منبع مشخص | P2     |

### ۳.۶ کش و صرفه‌جویی توکن

| فیچر                                                                                                                                           | منابع      | اولویت |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| Exact cache در Redis، S3 یا حافظه، با max-age، max-stale و invalidation                                                                        | A، H، L    | P1     |
| **Semantic cache** برای هر مدل، تیم یا کلید، با vector store                                                                                   | A، O، B، P | P1     |
| هدر وضعیت کش مانند `X-...-Cache: HIT` و گزارش صرفه‌جویی                                                                                        | O، A       | P1     |
| حسابداری prompt cache خود provider: cache reads/writes                                                                                         | NA         | P0     |
| **فشرده‌سازی context:** حذف تکرار در session، فیلتر خروجی ابزارها (git diff، grep، ls، tree)، compaction جدولی، relevance pruning، LLMLingua-2 | O، N       | P1     |
| پروفایل‌های فشرده‌سازی (Lite، Standard، Aggressive، Ultra) که با header هر درخواست قابل تنظیم‌اند                                              | O          | P1     |
| حالت خروجی کوتاه (Caveman / terse) با چند سطح                                                                                                  | N، O       | P2     |
| Anthropic Context Editing و کنترل بودجه‌ی context                                                                                              | O          | P2     |
| Compression Studio (رابط آزمایش) و ارزیابی آفلاین                                                                                              | O          | P2     |

### ۳.۷ کلید، دسترسی و هویت

| فیچر                                                                          | منابع             | اولویت |
| ----------------------------------------------------------------------------- | ----------------- | ------ |
| Virtual / gateway key با مدل‌های مجاز، تاریخ انقضا، IP allowlist و محدودیت‌ها | A، L، B، P، NA، R | P0     |
| ذخیره‌ی رمزشده‌ی اعتبارهای provider (AES-256-GCM، envelope encryption)        | A، O              | P0     |
| یکپارچه‌سازی Vault/KMS (HashiCorp، AWS KMS)                                   | B(ent)            | P2     |
| سلسله‌مراتب **Org → Team → Project → Key → User**                             | A، L، B           | P0     |
| نقش‌های سفارشی و RBAC                                                         | A، P، NA          | P1     |
| SSO: OIDC، SAML، GitHub، Google                                               | A، L، B           | P1     |
| SCIM provisioning و همگام‌سازی directory                                      | A، B              | P2     |
| MFA: TOTP، WebAuthn، passkeys                                                 | A، NA             | P1     |
| مدیریت session ورود                                                           | NA                | P1     |
| Change requestها برای عملیات حساس، مانند تأیید چهار-چشم (four-eyes)           | A                 | P2     |
| Audit log کامل                                                                | A، L، P           | P1     |
| گروه‌های دسترسی به مدل                                                        | L                 | P1     |
| ورود OAuth برای کاربران نهایی (GitHub، Google، Telegram، Discord، OIDC)       | NA                | P1     |
| محدودیت دسترسی بر اساس IP و جغرافیا                                           | P(ent)            | P2     |
| شناسه‌های کاربر نهایی برای ردیابی                                             | L، B              | P1     |

### ۳.۸ بودجه، سهمیه و rate limit

| فیچر                                                                 | منابع      | اولویت |
| -------------------------------------------------------------------- | ---------- | ------ |
| محدودیت RPM، TPM، تعداد درخواست همزمان و تعداد تصویر                 | A، L، H، R | P0     |
| بودجه‌ی دلاری یا توکنی در سطوح org، team، project، key، user و model | A، L، B، H | P0     |
| بودجه‌های روزانه، هفتگی و ماهانه با ریست خودکار                      | L          | P0     |
| پیش‌بینی هزینه و تاریخ پیش‌بینی‌شده‌ی اتمام بودجه                    | A          | P1     |
| یک **ledger** پشت هر عدد هزینه                                       | A          | P0     |
| پیگیری سهمیه‌ی اشتراک و شمارش معکوس تا ریست                          | N، O       | P1     |
| سهم عادلانه بین اعضای تیم که یک اشتراک مشترک دارند                   | O          | P2     |
| حسابداری استخر سهمیه‌ی رایگان بدون شمارش دوباره                      | O          | P2     |
| هشدار رسیدن به آستانه‌ی بودجه در ۵۰٪، ۸۰٪ و ۱۰۰٪                     | L          | P1     |

### ۳.۹ صورت‌حساب و کسب درآمد

این مجموعه‌ی کامل در Antirion و OmniRoute شناسایی نشد. منبع اصلی new-api بود که به‌عنوان «پنل فروش API» توصیف شده است. مواردی که با علامت † مشخص شده‌اند از مستندات یا نسخه‌های قبلی آمده‌اند و پیش از پیاده‌سازی باید دوباره بررسی شوند.

| فیچر                                                                           | منابع                    | اولویت |
| ------------------------------------------------------------------------------ | ------------------------ | ------ |
| کیف پول کاربر / اعتبار پیش‌پرداخت                                              | NA، OR                   | P1     |
| شارژ آنلاین از طریق Stripe و †Epay؛ گزینه‌های ایرانی: زرین‌پال، IDPay، NextPay | NA†                      | P1     |
| کدهای هدیه یا شارژ برای استفاده                                                | NA†                      | P1     |
| پاداش معرفی و affiliate                                                        | NA†                      | P2     |
| پلن‌های اشتراکی                                                                | NA، G(ent)               | P2     |
| ضرایب قیمت‌گذاری بر اساس مدل، خروجی، گروه کاربری و کش                          | NA                       | P1     |
| قیمت‌گذاری به ازای هر درخواست برای تصویر و ویدیو                               | NA                       | P1     |
| قیمت‌گذاری پلکانی مبتنی بر عبارت (expression-based)                            | NA                       | P2     |
| بازار عمومی مدل‌ها با قیمت                                                     | NA، OR                   | P1     |
| Bring your own key (BYOK)                                                      | OR                       | P1     |
| فاکتور، صورت‌حساب ماهانه، خروجی CSV/PDF                                        | نمونه‌ی کامل شناسایی نشد | P2     |
| گزارش سود: هزینه‌ی خرید از provider در برابر درآمد فروش                        | فرصت تمایز               | P2     |

### ۳.۱۰ Guardrail و امنیت محتوا

| فیچر                                                                              | منابع      | اولویت |
| --------------------------------------------------------------------------------- | ---------- | ------ |
| تشخیص PII و secret، از جمله API keyها و توکن‌ها                                   | A، O، L، P | P1     |
| Regex و فهرست کلمات                                                               | A، P       | P1     |
| اعتبارسنجی خروجی با JSON Schema                                                   | A، P       | P1     |
| تشخیص prompt injection                                                            | O          | P1     |
| Moderation مستقل از provider                                                      | A، O       | P1     |
| LLM-as-judge                                                                      | A، T       | P2     |
| بررسی مجوز ابزارها (tool-permission)                                              | A          | P2     |
| اعمال بررسی روی درخواست‌ها، پاسخ‌ها و **stream**ها                                | A          | P1     |
| اقدام‌ها: block، redact با حفظ قالب، flag، divert                                 | A          | P1     |
| پلاگین‌های guardrail شخص ثالث؛ پژوهش بیش از ۴۰ مورد در Portkey ثبت کرده است       | P          | P2     |
| لاگ محتوا به‌صورت پیش‌فرض خاموش است؛ در صورت فعال بودن، PII باید mask یا hash شود | A          | P0     |

### ۳.۱۱ ایجنت‌ها، MCP و A2A

| فیچر                                                                                                   | منابع      | اولویت |
| ------------------------------------------------------------------------------------------------------ | ---------- | ------ |
| **MCP Gateway:** ثبت سرورهای MCP و اعمال کلیدها، بودجه‌ها و لاگ‌ها روی آن‌ها                           | A، L، B، P | P1     |
| سرور MCP مدیریتی خود gateway روی stdio، HTTP و SSE؛ پژوهش ۱۱۰ ابزار OmniRoute را ثبت کرده است          | O          | P2     |
| ارسال هویت کاربر به سرورهای MCP                                                                        | P          | P2     |
| MCP Code Mode                                                                                          | B          | P2     |
| **A2A:** Agent Card در `/.well-known` و JSON-RPC (`message/send`، `tasks/get`)                         | A، O، L    | P2     |
| پروفایل ایجنت‌ها (Claude Code، Codex، OpenCode و غیره) با override مدل و پیکربندی یک‌کلیکی             | R، N، O    | P1     |
| راهنمای نصب برای Claude Code، Codex، Cursor، Cline، Roo، Kilo، Continue، Aider، Goose، Windsurf و غیره | O، N       | P0     |
| افزونه‌ی VS Code برای افزودن مدل به picker                                                             | O          | P2     |
| حافظه‌ی گفتگو (FTS/vector) همراه با کنترل نگه‌داری                                                     | O          | P2     |
| رله‌ی ایجنت از طریق Telegram، Slack، Discord                                                           | R          | P2     |

### ۳.۱۲ Observability و تحلیل

| فیچر                                                                                                                     | منابع      | اولویت |
| ------------------------------------------------------------------------------------------------------------------------ | ---------- | ------ |
| لاگ هر درخواست: مسیر انتخاب‌شده، **هر تلاش و دلیل شکست آن**، توکن‌ها، هزینه، وضعیت کش، نتیجه‌ی guardrail، latency و TTFT | A، R، L    | P0     |
| Tracing ایجنت و tool-call                                                                                                | R          | P1     |
| Prometheus metrics                                                                                                       | A، B، T، L | P0     |
| OpenTelemetry: traces، metrics، logs                                                                                     | A، H، T، L | P1     |
| Sinkهای لاگ خارجی: Langfuse، Datadog، S3، Kafka                                                                          | A، L       | P2     |
| دیتابیس لاگ جداگانه (ClickHouse)                                                                                         | NA         | P1     |
| Replay درخواست‌های قبلی با مدل یا prompt متفاوت                                                                          | T          | P2     |
| ساخت dataset از ترافیک واقعی، همراه با ارزیابی و feedback                                                                | T          | P2     |
| هشدار از طریق Slack، Telegram، ایمیل و webhook                                                                           | L، NA†     | P1     |

### ۳.۱۳ پیکربندی و عملیات

| فیچر                                                             | منابع    | اولویت                                    |
| ---------------------------------------------------------------- | -------- | ----------------------------------------- |
| پیکربندی اعلانی YAML که از طریق فایل، API یا کنسول ویرایش می‌شود | A، H     | P1                                        |
| اعتبارسنجی schema، **diff، نسخه‌بندی و rollback**                | A        | P1                                        |
| Hot reload بدون ری‌استارت                                        | C، A     | P0                                        |
| GitOps                                                           | T        | P2                                        |
| ویزارد راه‌اندازی اولیه                                          | NA       | P0                                        |
| پروکسی خروجی SOCKS5/HTTP در سطح کل سیستم، provider یا اتصال      | O، N     | P0؛ به‌ویژه برای استقرار در ایران مهم است |
| Proxy pool، چرخش IP و relay                                      | N، O     | P1                                        |
| تونل دسترسی از راه دور (Cloudflare Tunnel)                       | N        | P2                                        |
| کنترل egress برای IPv4 و IPv6                                    | O        | P2                                        |
| بین‌المللی‌سازی، از جمله **فارسی و RTL**                         | NA       | P0                                        |
| Playground مدل                                                   | NA، T، G | P1                                        |
| سیستم middleware / پلاگین                                        | B، NA، R | P2                                        |
| Management API کامل که همه‌ی عملیات UI را پوشش دهد               | C، A     | P0                                        |
| SDK قابل embed                                                   | C        | P2                                        |

### ۳.۱۴ استقرار و زنجیره‌ی تأمین

| فیچر                                                                          | منابع    | اولویت |
| ----------------------------------------------------------------------------- | -------- | ------ |
| تصاویر Docker بدون سیستم‌عامل کامل (distroless) و غیر-root برای amd64 و arm64 | A، O، NA | P0     |
| Docker Compose برای استقرار تک‌نود و کلاستری                                  | A، C     | P0     |
| Helm chart با HPA autoscaling                                                 | A، L     | P1     |
| حالت شخصی سبک تک‌نود با ذخیره‌سازی embedded                                   | A، O     | P2     |
| npm، برنامه‌ی دسکتاپ Electron/Tauri، PWA                                      | O، N، R  | P2     |
| SBOM، امضاهای Sigstore، SLSA provenance                                       | A        | P2     |
| Benchmark harness منتشرشده                                                    | A، H     | P1     |

---

## ۴. ماتریس مقایسه‌ی فیچرها

راهنما: ✅ دارد، ⚠️ جزئی یا فقط در نسخه‌ی پولی، ❌ ندارد یا گزارش نشده. این‌ها ارزیابی‌های اولیه‌ی پژوهش هستند، نه مشخصات تأییدشده‌ی فعلی محصول.

| قابلیت                                | Antirion | OmniRoute     | 9Router | LiteLLM | Bifrost | Portkey | new-api | CLIProxy | CCR | **هدف DiRouter** |
| ------------------------------------- | -------- | ------------- | ------- | ------- | ------- | ------- | ------- | -------- | --- | ---------------- |
| OpenAI / Anthropic / Gemini API       | ✅       | ✅            | ✅      | ✅      | ✅      | ✅      | ✅      | ✅       | ✅  | ✅               |
| تبدیل فرمت                            | ✅       | ✅            | ✅      | ✅      | ✅      | ✅      | ✅      | ✅       | ✅  | ✅               |
| تعداد provider                        | ~17      | 350+          | 60+     | 100+    | 23+     | 45+     | ~30+    | ~10      | ~10 | 50+              |
| اشتراک OAuth                          | ❌       | ✅            | ✅      | ⚠️      | ❌      | ❌      | ❌      | ✅       | ⚠️  | ⚠️ پلاگین        |
| تصویر، صوت، ویدیو                     | ❌       | ⚠️            | ✅      | ✅      | ⚠️      | ✅      | ✅      | ❌       | ❌  | ✅               |
| Combo / مدل مجازی                     | ⚠️       | ✅            | ✅      | ⚠️      | ❌      | ✅      | ⚠️      | ❌       | ✅  | ✅               |
| تعداد استراتژی‌های routing            | ~7       | 19            | 2       | ~5      | ~2      | ~3      | ~2      | 1        | ~2  | 15+              |
| Classifier routing                    | ✅       | ✅ auto       | ❌      | ❌      | ❌      | ⚠️      | ❌      | ⚠️       | ⚠️  | ✅               |
| Circuit breaker                       | ✅       | ✅            | ❌      | ⚠️      | ✅      | ❌      | ⚠️      | ❌       | ❌  | ✅               |
| Request hedging                       | ✅       | ❌            | ❌      | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅               |
| Cooldown اعتبار / lockout مدل         | ⚠️       | ✅            | ⚠️      | ✅      | ⚠️      | ❌      | ✅      | ⚠️       | ⚠️  | ✅               |
| Exact cache                           | ✅       | ⚠️            | ❌      | ✅      | ⚠️      | ✅      | ❌      | ❌       | ❌  | ✅               |
| Semantic cache                        | ✅       | ✅            | ❌      | ✅      | ✅      | ⚠️      | ❌      | ❌       | ❌  | ✅               |
| فشرده‌سازی context                    | ❌       | ✅ 12 engines | ✅ RTK  | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅               |
| Virtual keys / بودجه‌های سلسله‌مراتبی | ✅       | ⚠️            | ❌      | ✅      | ✅      | ✅      | ✅      | ❌       | ⚠️  | ✅               |
| Rate limits (RPM/TPM/cost)            | ✅       | ✅            | ❌      | ✅      | ✅      | ⚠️      | ⚠️      | ❌       | ✅  | ✅               |
| SSO / SCIM                            | ✅       | ❌            | ❌      | ⚠️      | ⚠️      | ⚠️      | ⚠️ OIDC | ❌       | ❌  | ✅               |
| MFA / passkey                         | ✅       | ❌            | ❌      | ❌      | ❌      | ❌      | ✅      | ❌       | ❌  | ✅               |
| RBAC / audit                          | ✅       | ❌            | ❌      | ⚠️      | ⚠️      | ✅      | ⚠️      | ❌       | ❌  | ✅               |
| **صورت‌حساب / شارژ**                  | ❌       | ⚠️ cloud      | ❌      | ❌      | ❌      | ❌      | ✅      | ❌       | ❌  | ✅               |
| Guardrailها                           | ✅       | ✅            | ❌      | ✅      | ⚠️      | ✅      | ❌      | ❌       | ❌  | ✅               |
| MCP Gateway                           | ✅       | ✅            | ❌      | ✅      | ✅      | ✅      | ❌      | ❌       | ✅  | ✅               |
| A2A                                   | ✅       | ✅            | ❌      | ✅      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅ P2            |
| Prometheus / OpenTelemetry            | ✅       | ❌            | ❌      | ✅      | ✅      | ⚠️      | ❌      | ❌       | ❌  | ✅               |
| داشبورد تحلیلی                        | ✅       | ✅            | ⚠️      | ✅      | ✅      | ⚠️      | ✅      | ❌       | ✅  | ✅++             |
| Diff / rollback پیکربندی              | ✅       | ❌            | ❌      | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅               |
| Proxy خروجی / pool                    | ❌       | ✅            | ✅      | ⚠️      | ❌      | ❌      | ✅      | ⚠️       | ❌  | ✅               |
| Clustering / HA                       | ✅       | ⚠️            | ❌      | ✅      | ⚠️      | ✅      | ✅      | ✅       | ❌  | ✅               |
| Helm / Kubernetes                     | ✅       | ❌            | ❌      | ✅      | ⚠️      | ✅      | ⚠️      | ❌       | ❌  | ✅               |
| فارسی / RTL                           | ❌       | ❌            | ❌      | ❌      | ❌      | ❌      | ❌      | ❌       | ❌  | ✅               |

---

## ۵. طراحی تاب‌آوری پیشنهادی DiRouter

اصل اول: **data plane نباید به control plane وابسته باشد.** قطع شدن PostgreSQL، NestJS یا داشبورد نباید ترافیک جاری را مختل کند.

1. **جداسازی data plane و control plane.** gateway پیکربندی را از control plane دریافت می‌کند، یک snapshot نسخه‌دار را در حافظه و روی دیسک نگه می‌دارد، و به‌روزرسانی‌ها را از طریق Valkey pub/sub یا long polling می‌گیرد. در زمان قطعی control plane، با آخرین پیکربندی معتبر ادامه می‌دهد.
2. **gatewayهای stateless با شمارنده‌های توزیع‌شده.** rate limit و بودجه در Valkey با sliding window یا GCRA و Lua script پیاده‌سازی می‌شوند. **fallback محلی:** سهمیه بین نودها تقسیم شود و وقتی Valkey در دسترس نیست، محدودسازی داخل حافظه انجام شود. حالت fail-open یا fail-closed برای هر tenant قابل تنظیم باشد.
3. **حسابداری ناهمگام.** مصرف لحظه‌ای در Valkey ثبت می‌شود (برای کنترل بودجه)، سپس رویدادها وارد صف می‌شوند (NATS JetStream یا Redis Streams) و از آنجا در ledger روی PostgreSQL و لاگ‌ها در ClickHouse ذخیره می‌شوند. مسیر درخواست هرگز منتظر نوشتن در دیتابیس نمی‌ماند. یک **idempotency key** از شمارش دوباره‌ی هزینه جلوگیری می‌کند؛ یک outbox محلی روی دیسک برای زمان قطعی صف در نظر گرفته شده است. MVP پذیرفته‌شده بعداً BullMQ و لاگ‌های PostgreSQL را انتخاب کرد.
4. **سه لایه‌ی جداسازی خطا، بر اساس الگوی OmniRoute:** circuit breaker برای هر provider، cooldown برای هر کلید، و lockout برای هر مدل؛ همراه با half-open probe و backoff تطبیقی.
5. **Hedging و timeoutها:** timeout جداگانه برای اتصال، TTFT و idle بودن stream. اگر TTFT از p95 بیشتر شود، می‌توان یک hedge به provider دوم فرستاد؛ فقط برای درخواست‌های idempotent یا با یک hedge budget مشخص.
6. **failover امن برای stream:** تا پیش از ارسال اولین بایت به کلاینت، fallback کامل مجاز است. پس از ارسال بخشی از پاسخ، یک خطای استاندارد برگردانده می‌شود. ادامه‌ی stream بین providerهای مختلف یک کار آزمایشی P2 است.
7. **Bulkhead:** connection poolها و محدودیت‌های concurrency جداگانه برای هر provider و هر tenant، تا یک provider کند یا یک مشتری پرمصرف کل سیستم را از کار نیندازد.
8. **پیشنهاد زیرساخت:** PostgreSQL با Patroni یا CloudNativePG (primary/replica) و PgBouncer؛ Valkey Sentinel یا Cluster؛ ClickHouse در ابتدا تک‌نود؛ replicaهای gateway پشت load balancer، با PodDisruptionBudget، readiness و liveness probe و graceful drain برای SSE.
9. **تست Chaos و تست بار:** k6 یا vegeta همراه با یک mock provider که در CI خطاهای 429، 5xx و latency تصادفی تولید می‌کند. SLOهای پیشنهادی: overhead در p99 کمتر از ۵ ms و دسترس‌پذیری ۹۹٫۹۵٪.

---

## ۶. داشبورد عملی — صفحات پیشنهادی

ترکیبی از Overview و لاگ‌های تلاش‌به‌تلاش Antirion، تب‌های Health و Costs از OmniRoute، marketplace مدل و playground از new-api، و request diagnostics از CCR.

| صفحه                            | محتوا                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**                    | هزینه، درخواست‌ها، توکن‌ها، latency در p50/p95/p99، TTFT، نرخ خطا و cache-hit، صرفه‌جویی (کش، فشرده‌سازی، مسیرهای رایگان)، مدل‌ها و تیم‌های برتر، **headroom هر provider** |
| **Live / Realtime**             | جریان زنده‌ی درخواست‌ها (WebSocket)، RPS فعلی، درخواست‌های در حال اجرا، نقشه‌ی وضعیت providerها                                                                            |
| **Health**                      | وضعیت circuit breakerهای providerها، کلیدهای در cooldown، مدل‌های قفل‌شده و زمان بازگشایی آن‌ها، تاریخچه‌ی incidentها و uptime هر provider                                 |
| **Requests (Log Explorer)**     | فیلتر بر اساس کلید/تیم/مدل/وضعیت/هزینه/latency؛ جزئیات درخواست با timeline تلاش‌ها، دلیل شکست، نتیجه‌ی guardrail، وضعیت کش، body اختیاری، و replay در playground           |
| **Costs & Budgets**             | هزینه بر اساس org/team/project/key/user/model، پیش‌بینی و تاریخ اتمام بودجه، ledger، تفکیک اشتراک/رایگان/پولی، خروجی CSV                                                   |
| **Quotas**                      | سهمیه‌ی اکانت و اشتراک، شمارش معکوس تا ریست، میزان استفاده                                                                                                                 |
| **Providers & Credentials**     | wizard افزودن provider، تست اتصال، کشف مدل، چند اعتبار برای هر provider، تنظیمات proxy برای هر اتصال                                                                       |
| **Models / Catalog**            | قیمت‌ها، پنجره‌ی context، قابلیت‌ها، aliasها و mappingها، بازار عمومی مدل                                                                                                  |
| **Routing / Combos**            | ویرایشگر drag-and-drop برای زنجیره‌ی fallback و استراتژی، **routing simulator**، سهم ترافیک هر قاعده                                                                       |
| **Keys & Access**               | virtual keyها، مدل‌های مجاز، محدودیت‌ها، انقضا، IP allowlist، چرخش کلید                                                                                                    |
| **Org / Teams / Users / Roles** | سلسله‌مراتب، RBAC، SSO و SCIM، دعوت                                                                                                                                        |
| **Billing**                     | کیف پول، شارژ، کدهای هدیه، پلن‌ها، فاکتور، قیمت گروه‌ها، گزارش سود                                                                                                         |
| **Guardrails**                  | policyها، تست زنده، آمار block و redact                                                                                                                                    |
| **Cache & Compression**         | نرخ hit، صرفه‌جویی، پاک‌سازی کش، Compression Studio                                                                                                                        |
| **MCP & Agents**                | ثبت سرورهای MCP، دسترسی و لاگ ابزارها، پروفایل ایجنت‌ها با snippet آماده برای Claude Code و Codex                                                                          |
| **Playground**                  | مقایسه‌ی کنار هم مدل‌ها با هزینه و latency                                                                                                                                 |
| **Config**                      | ویرایش YAML با اعتبارسنجی، diff، تاریخچه، rollback، change requestها                                                                                                       |
| **Alerts**                      | قوانین بودجه، خطا و قطعی providerها و کانال‌های Telegram، Slack، email و webhook                                                                                           |
| **Audit Log**                   | هر تغییر پیکربندی به همراه diff                                                                                                                                            |

پیشنهادهای UX:

- RTL و LTR کامل، تقویم شمسی و میلادی، تم روشن و تیره.
- بازه‌ی زمانی سراسری، drill-down از نمودار به لاگ، لینک‌های قابل اشتراک‌گذاری برای فیلترها.
- Command palette (`Cmd+K`).

---

## ۷. پیشنهاد فنی اولیه

### ۷.۱ ارزیابی NestJS + React + PostgreSQL

| لایه                                                          | انتخاب اولیه کاربر | ارزیابی پژوهش                                                                                                                                                                                                                       | پیشنهاد اولیه                                                                                                                             |
| ------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Control plane:** Admin API، auth، billing، config، گزارش‌ها | NestJS             | تطابق قوی: ماژول‌ها، DI، guardها و RBAC، OpenAPI، اکوسیستم                                                                                                                                                                          | **NestJS با Fastify adapter**                                                                                                             |
| **Data plane:** مسیر داغ درخواست‌های LLM                      | NestJS             | پژوهش، DI/interceptorها و pipeهای هر درخواست و GC و اجرای تک‌رشته‌ای Node را در ده‌ها هزار stream همزمان، ریسک latency دم‌بلند و مصرف بیشتر حافظه می‌دانست. این پژوهش gatewayهای Rust/Go را با پروژه‌های محلی Node مقایسه کرده بود. | **Go**، با Rust به‌عنوان جایگزین؛ بعداً با ADR-001 جایگزین شد                                                                             |
| **Frontend**                                                  | React              | مناسب                                                                                                                                                                                                                               | React + Vite + TypeScript، TanStack Router/Query، shadcn/ui (Radix) + Tailwind با RTL، ECharts یا Recharts، TanStack Table، react-i18next |
| **Primary database**                                          | PostgreSQL         | تطابق قوی برای کاربران، کلیدها، config و ledger                                                                                                                                                                                     | **PostgreSQL 17** + PgBouncer                                                                                                             |
| **Logs and analytics**                                        | PostgreSQL         | پژوهش مشکلات احتمالی را با میلیون‌ها ردیف خام لاگ در روز و aggregateهای سریع پیش‌بینی کرد                                                                                                                                           | **ClickHouse**، مانند new-api؛ TimescaleDB برای حجم کم هم گزینه‌ی اولیه‌ی دیگری بود                                                       |
| **Counters, cache, pub/sub**                                  | مشخص نشده          | لازم است                                                                                                                                                                                                                            | **Valkey**، یک فورک باز از Redis                                                                                                          |
| **Event queue**                                               | مشخص نشده          | لازم است                                                                                                                                                                                                                            | **NATS JetStream**، یا در ابتدا Redis Streams                                                                                             |
| **Vectors for semantic cache/memory**                         | مشخص نشده          | لازم است                                                                                                                                                                                                                            | **pgvector** روی PostgreSQL؛ در مقیاس بالاتر Qdrant                                                                                       |

### ۷.۲ چرا Go برای data plane؟

منطق اصلی پژوهش این بود:

- Overhead زیر میلی‌ثانیه و latency دم‌بلند پایدار، با استناد به Bifrost به‌عنوان نمونه‌ی Go.
- Goroutineها برای تعداد زیادی stream همزمان SSE مناسب‌اند و `net/http` و `httputil` بالغ هستند.
- CLIProxyAPI و new-api نمونه‌هایی از translatorها و executorها در Go هستند.
- یادگیری Go برای تیم TypeScript ساده‌تر از Rust است. Rust عمدتاً برای یک چالش مستقیم کارایی در برابر Antirion پیشنهاد شده بود.
- **اگر تیم فقط TypeScript می‌داند،** گزینه‌ی دیگر این بود که data plane به‌صورت یک سرویس جدا با Node + Fastify یا uWebSockets خالص (بدون Nest) ساخته شود، با رابط پایدار که بعداً بتوان آن را با Go جایگزین کرد. پژوهش همچنان برای هدف مقیاس بالا، Go را ترجیح می‌داد.

این‌ها پیشنهادهای طراحی بودند، نه نتایج اندازه‌گیری‌شده‌ی DiRouter. ADR-001 بعداً NestJS روی Fastify را همراه با قواعد سخت‌گیرانه برای مسیر داغ و گزینه‌ی بازنویسی مبتنی بر benchmark انتخاب کرد.

### ۷.۳ ساختار مونوریپوی پیشنهادی اولیه

```text
dirouter/
├─ apps/
│  ├─ gateway/          # Go data plane: routing, fallback, limits, translation
│  ├─ control-api/      # NestJS: administration, auth, billing, config
│  ├─ worker/           # NestJS: ledger, aggregates, alerts, health probes
│  ├─ dashboard/        # React + Vite management console
│  ├─ portal/           # Optional React end-user wallet/model marketplace
│  └─ docs/             # Astro Starlight or Docusaurus documentation site
├─ packages/
│  ├─ contracts/        # JSON Schema / OpenAPI / Protobuf shared by Go and TS
│  ├─ model-catalog/    # Versioned JSON prices and capabilities
│  ├─ ui/               # Shared React components
│  ├─ sdk-ts/           # Management SDK
│  └─ config/           # ESLint, tsconfig, and related configuration
├─ deploy/             # Docker Compose, Helm, Kubernetes
└─ tools/              # Mock provider, load tests, chaos
```

- ابزار مونوریپو: **pnpm workspaces + Turborepo**، یا **Nx** با پلاگین Go.
- ORM در NestJS: **Drizzle** یا **Prisma**. تجربه‌ی موجود تیم با Prisma از نگه داشتن آن پشتیبانی می‌کرد. migrationها باید از یک منبع واحد اجرا شوند.
- قرارداد بین Go و TS: snapshotهای پیکربندی به‌صورت JSON با یک schema مشترک. ارتباط داخلی می‌تواند با gRPC یا HTTP و به‌علاوه‌ی Valkey pub/sub انجام شود.

ساختار واقعی مخزن با TypeScript در [README پروژه](../../../README.fa.md) مستند شده است.

---

## ۸. نقشه‌ی راه اولیه‌ی پیشنهادی

| فاز          | محدوده                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MVP (P0)** | APIهای OpenAI و Anthropic و تبدیل بین آن‌ها، حدود ۱۵ provider اصلی به‌علاوه‌ی سرورهای OpenAI-compatible، combo و fallback چندسطحی، circuit breaker، cooldown، lockout، retry و timeout، virtual keys، org/team/project، rate limit و بودجه، ledger، لاگ درخواست‌ها، proxy خروجی، صفحات Overview، Health، Requests، Providers، Keys و Combos، فارسی و RTL، Docker Compose |
| **v1 (P1)**  | APIهای کامل Gemini و Responses، مسیریابی latency/cost/headroom/classifier، hedging، کش exact و semantic، فشرده‌سازی RTK و dedup، SSO/MFA/RBAC/audit، guardrailها، MCP gateway، صورت‌حساب (کیف پول، درگاه، کد هدیه، ضرایب قیمت)، ClickHouse، OTel و Prometheus، Helm، diff و rollback پیکربندی، playground، هشدارها                                                       |
| **v2 (P2)**  | تصویر، صوت، ویدیو و جستجوی کامل، A2A، حافظه، SCIM، پلاگین‌ها، A/B و ارزیابی‌ها، افزونه‌ی VS Code، دسکتاپ، پلاگین‌های اختیاری اشتراک OAuth همراه با اعلان شرایط، SBOM و امضا                                                                                                                                                                                              |

---

## ۹. تصمیم‌های درخواست‌شده در پژوهش

1. **مدل کسب‌وکار:** فقط self-hosting سازمانی مانند Antirion، یا یک پنل فروش API مانند new-api و OpenRouter هم؟ این انتخاب وزن کار billing را تعیین می‌کند.
2. **اشتراک‌های OAuth و web-cookie:** حذف شوند، به‌صورت پلاگین اختیاری ارائه شوند، یا با درنظر گرفتن شرایط سرویس، در هسته قرار گیرند؟
3. **زبان data plane:** Go، Rust یا Node خالص؟ پژوهش Go را ترجیح می‌داد؛ ADR-001 انتخاب نهایی پذیرفته‌شده‌ی بعدی را ثبت کرده است.
4. **درگاه‌های پرداخت:** ایرانی، بین‌المللی یا هر دو؟

---

## منابعی که پژوهش ثبت کرده است

- [Antirion](https://antirion.ai/)
- [وب‌سایت OmniRoute](https://www.omniroute.online/) و [مخزن](https://github.com/cheaper-inference/OmniRoute)
- [وب‌سایت 9Router](https://9router.com/) و [مخزن](https://github.com/decolua/9router)
- [مستندات proxy مربوط به LiteLLM](https://docs.litellm.ai/docs/simple_proxy)
- [مخزن Bifrost](https://github.com/maximhq/bifrost)
- [مخزن Portkey Gateway](https://github.com/Portkey-AI/gateway)
- [مخزن new-api](https://github.com/QuantumNous/new-api) و [مستندات](https://docs.newapi.ai/)
- [مخزن CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [مخزن Claude Code Router](https://github.com/musistudio/claude-code-router)
- [مخزن TensorZero](https://github.com/tensorzero/tensorzero)
- [مخزن Helicone AI Gateway](https://github.com/Helicone/ai-gateway)
- [مخزن LLM Gateway](https://github.com/theopenco/llmgateway)
- [Maxim: جایگزین‌های Portkey](https://www.getmaxim.ai/articles/top-5-portkey-alternatives-in-2026/)
- [LLM Gateway: جایگزین‌های LiteLLM](https://llmgateway.io/blog/litellm-alternatives)
- [Coworker: جایگزین‌های LiteLLM](https://coworker.ai/blog/litellm-alternatives)

</div>
